require('dotenv').config();
const { Web3 } = require('web3');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const TOKEN_ABI = require('./abis/tokenabi');
const ICO_ABI = require('./abis/icoabi');

// Configuration
class Config {
    static BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;
    static TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    static TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
    static ICO_ADDRESS = process.env.ICO_ADDRESS;
    static TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
    static IMAGE_PATH = process.env.IMAGE_PATH;
    static FALLBACK_IMAGE_URL = process.env.FALLBACK_IMAGE_URL;
    static STONEFORM_WEBSITE = process.env.STONEFORM_WEBSITE;
    static STONEFORM_WHITEPAPER = process.env.STONEFORM_WHITEPAPER;
    static CACHE_FILE = process.env.CACHE_FILE;
    static LOG_FILE = process.env.LOG_FILE;
    static BSC_NODE_URL = process.env.BSC_NODE_URL;
    static POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL) || 30;
    static REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10;
    static MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
    static FALLBACK_PRICE = parseFloat(process.env.FALLBACK_PRICE) || 0.0001;
    static FALLBACK_SUPPLY = parseFloat(process.env.FALLBACK_SUPPLY) || 1000000;
    static FALLBACK_NAME = process.env.FALLBACK_NAME || "Stoneform";
    static FALLBACK_SYMBOL = process.env.FALLBACK_SYMBOL || "TOKEN";
    static FALLBACK_DECIMALS = parseInt(process.env.FALLBACK_DECIMALS) || 18;
}

// Setup logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} - ${level.toUpperCase()} - ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: Config.LOG_FILE }),
        new winston.transports.Console()
    ]
});

// Initialize Web3 and Telegram bot
const w3 = new Web3(Config.BSC_NODE_URL);
const bot = new TelegramBot(Config.TELEGRAM_BOT_TOKEN, { polling: false });

const TRANSFER_EVENT_ABI = {
    "anonymous": false,
    "inputs": [
        {"indexed": true, "name": "from", "type": "address"},
        {"indexed": true, "name": "to", "type": "address"},
        {"indexed": false, "name": "value", "type": "uint256"}
    ],
    "name": "Transfer",
    "type": "event"
};

// Cache class
class Cache {
    constructor() {
        this.cacheFile = Config.CACHE_FILE;
        this.knownAddresses = new Set();
        this.lastTxHash = null;
    }

    async loadCache() {
        try {
            if (await fs.access(Config.CACHE_FILE).then(() => true).catch(() => false)) {
                const data = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
                this.knownAddresses = new Set(data.known_addresses || []);
                this.lastTxHash = data.last_tx_hash || null;
                logger.info(`Cache loaded: ${this.knownAddresses.size} addresses, last tx: ${this.lastTxHash}`);
            }
        } catch (e) {
            logger.error(`Error loading cache: ${e.message}`);
        }
    }

    async saveCache() {
        try {
            await fs.writeFile(this.cacheFile, JSON.stringify({
                known_addresses: Array.from(this.knownAddresses),
                last_tx_hash: this.lastTxHash
            }));
            logger.info("Cache saved successfully");
        } catch (e) {
            logger.error(`Error saving cache: ${e.message}`);
        }
    }
}

// LRU Cache for token info
const tokenInfoCache = new Map();
async function getTokenInfo() {
    if (tokenInfoCache.size > 0) return tokenInfoCache.get('tokenInfo');
    
    try {
        const contract = new w3.eth.Contract(TOKEN_ABI, Config.TOKEN_ADDRESS);
        const [symbol, name, initialSupply, decimals] = await Promise.all([
            contract.methods.symbol().call(),
            contract.methods.name().call(),
            contract.methods.INITIAL_SUPPLY().call(),
            contract.methods.decimals().call()
        ]);
        // Convert BigInt to number safely
        const adjustedSupply = Number(BigInt(initialSupply) / BigInt(10 ** Number(decimals)));
        logger.info(`Token Info - Name: ${name}, Symbol: ${symbol}, Initial Supply: ${adjustedSupply.toLocaleString()}, Decimals: ${decimals}`);
        tokenInfoCache.set('tokenInfo', [name, symbol, adjustedSupply, decimals]);
        return [name, symbol, adjustedSupply, decimals];
    } catch (e) {
        logger.error(`Error fetching token info for ${Config.TOKEN_ADDRESS}: ${e.message}`);
        return [Config.FALLBACK_NAME, Config.FALLBACK_SYMBOL, Config.FALLBACK_SUPPLY, Config.FALLBACK_DECIMALS];
    }
}

// LRU Cache for token price
const priceCache = new Map();
async function tokenPricePerUSD() {
    if (priceCache.size > 0) return priceCache.get('price');
    
    try {
        const contract = new w3.eth.Contract(ICO_ABI, Config.ICO_ADDRESS);
        const [tokenAmountPerUSD, contractTokenAddress] = await Promise.all([
            contract.methods.tokenAmountPerUSD().call(),
            contract.methods.tokenAddress().call()
        ]);
        
        if (contractTokenAddress.toLowerCase() !== Config.TOKEN_ADDRESS.toLowerCase()) {
            logger.warn(`ICO contract token address mismatch: ${contractTokenAddress} vs ${Config.TOKEN_ADDRESS}`);
            return Config.FALLBACK_PRICE;
        }
        
        const tokenContract = new w3.eth.Contract(TOKEN_ABI, Config.TOKEN_ADDRESS);
        const decimals = await tokenContract.methods.decimals().call();
        
        const tokenAmount = BigInt(tokenAmountPerUSD);
        if (tokenAmount === BigInt(0)) {
            logger.warn("tokenAmountPerUSD is 0");
            return Config.FALLBACK_PRICE;
        }
        
        const priceUSD = 1 / (Number(tokenAmount) / Math.pow(10, Number(decimals)));
        logger.info(`Token Price: ${priceUSD.toFixed(6)} USD`);
        priceCache.set('price', priceUSD);
        return priceUSD;
    } catch (e) {
        logger.error(`Error fetching price for ${Config.ICO_ADDRESS}: ${e.message}`);
        return Config.FALLBACK_PRICE;
    }
}

async function fetchWithRetry(url, retries = Config.MAX_RETRIES) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.get(url, { timeout: Config.REQUEST_TIMEOUT * 1000 });
            logger.debug(`Fetched data from ${url}: ${response.data.status}`);
            return response.data;
        } catch (e) {
            logger.error(`Request failed (attempt ${attempt + 1}/${retries}): ${e.message}`);
            if (attempt < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }
    return null;
}

async function getTokenTransactions() {
    let transactions = [];
    
    // Try tokentx endpoint first for token-specific transfers
    let url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${Config.TOKEN_ADDRESS}&address=${Config.ICO_ADDRESS}&sort=desc&apikey=${Config.BSCSCAN_API_KEY}`;
    let data = await fetchWithRetry(url);
    if (data?.status === "1" && data.result) {
        // Filter for successful transactions only
        transactions = data.result.filter(tx => tx.isError === "0");
        logger.info(`Found ${transactions.length} successful token transactions for ICO_ADDRESS ${Config.ICO_ADDRESS} via tokentx`);
    } else {
        logger.warn(`No token transactions found via tokentx: ${data?.message || 'Request failed'}`);
    }
    
    // Fallback to txlist if no token transactions
    if (!transactions.length) {
        url = `https://api.bscscan.com/api?module=account&action=txlist&address=${Config.ICO_ADDRESS}&sort=desc&apikey=${Config.BSCSCAN_API_KEY}`;
        data = await fetchWithRetry(url);
        if (data?.status === "1" && data.result) {
            transactions = data.result.filter(tx => tx.isError === "0");
            logger.info(`Found ${transactions.length} successful transactions for ICO_ADDRESS ${Config.ICO_ADDRESS} via txlist`);
        } else {
            logger.warn(`No transactions found via txlist: ${data?.message || 'Request failed'}`);
        }
    }
    
    return transactions;
}

function isNewHolder(fromAddress, cache) {
    if (!fromAddress) {
        logger.warn("Empty from_address, assuming new holder");
        return true;
    }
    
    logger.debug(`Checking if ${fromAddress} is a new holder. Known addresses: ${Array.from(cache.knownAddresses)}`);
    if (cache.knownAddresses.has(fromAddress.toLowerCase())) {
        logger.info(`Address ${fromAddress} already in cache, marking as existing holder`);
        return false;
    }
    
    cache.knownAddresses.add(fromAddress.toLowerCase());
    cache.saveCache();
    logger.info(`Added new holder ${fromAddress} to cache`);
    return true;
}

async function getTransferEventValue(txHash, decimals) {
    try {
        const receipt = await w3.eth.getTransactionReceipt(txHash);
        if (!receipt || !receipt.logs) {
            logger.debug(`No logs found in transaction receipt for tx ${txHash}`);
            return 0.0;
        }

        const contract = new w3.eth.Contract([TRANSFER_EVENT_ABI], Config.TOKEN_ADDRESS);
        const logs = contract.events.Transfer({}).decodeLogs(receipt.logs);
        
        for (const log of logs) {
            if (log.address.toLowerCase() === Config.TOKEN_ADDRESS.toLowerCase()) {
                const value = Number(BigInt(log.args.value) / BigInt(10 ** Number(decimals)));
                logger.info(`Found Transfer event in tx ${txHash}: ${value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} tokens`);
                return value;
            }
        }
        logger.debug(`No Transfer event found in tx ${txHash}`);
        return 0.0;
    } catch (e) {
        logger.error(`Error fetching Transfer event for tx ${txHash}: ${e.message}`);
        return 0.0;
    }
}

async function sendToTelegram(transaction, initialSupply, price, name, symbol, decimals, volume24h, cache) {
    let amountToken = transaction.value ? Number(BigInt(transaction.value) / BigInt(10 ** Number(decimals))) : 0.0;
    if (amountToken === 0.0) {
        amountToken = await getTransferEventValue(transaction.hash, decimals);
    }
    
    // Skip if no valid token amount
    if (amountToken === 0.0) {
        logger.info(`Skipping Telegram message for tx ${transaction.hash} due to zero token amount`);
        return;
    }
    
    const amountUSD = amountToken * price;
    const holdersCount = cache.knownAddresses.size;
    const newHolder = isNewHolder(transaction.from || "", cache);
    
    const message = `
<b>🚀 ${name} (${symbol}) 🚀</b>

<b>New Transaction Alert 📢</b>
📍 Amount: ${amountToken.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${symbol}
💰 USD Value: $${amountUSD.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
📈 Price: $${price.toFixed(6)}
💸 Initial Supply: ${initialSupply.toLocaleString()} ${symbol}
👥 Holders: ${holdersCount.toLocaleString()}
ℹ️ Status: ${newHolder ? 'New Holder!' : 'Existing Holder'}
⏰ Time: ${new Date(Number(transaction.timeStamp) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC
<a href='https://bscscan.com/tx/${transaction.hash}'>View on BscScan</a>

<a href='${Config.STONEFORM_WEBSITE}'>Website</a> | <a href='${Config.STONEFORM_WHITEPAPER}'>Whitepaper</a>
    `;
    
    logger.info(`Sending Telegram message for tx ${transaction.hash} (length: ${message.length})`);

    for (let attempt = 0; attempt < Config.MAX_RETRIES; attempt++) {
        try {
            if (await fs.access(Config.IMAGE_PATH).then(() => true).catch(() => false)) {
                await bot.sendPhoto(Config.TELEGRAM_CHANNEL_ID, Config.IMAGE_PATH, {
                    caption: message,
                    parse_mode: 'HTML'
                });
                logger.info("Message sent with local image");
                return;
            } else {
                await bot.sendPhoto(Config.TELEGRAM_CHANNEL_ID, Config.FALLBACK_IMAGE_URL, {
                    caption: message,
                    parse_mode: 'HTML'
                });
                logger.info("Message sent with fallback image");
                return;
            }
        } catch (e) {
            if (e.code === 429) {
                logger.warn(`Rate limit hit, retrying after ${e.response.parameters.retry_after} seconds`);
                await new Promise(resolve => setTimeout(resolve, e.response.parameters.retry_after * 1000));
            } else {
                logger.error(`Telegram error (attempt ${attempt + 1}/${Config.MAX_RETRIES}): ${e.message}`);
                if (attempt < Config.MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
                }
            }
        }
    }

    try {
        await bot.sendMessage(Config.TELEGRAM_CHANNEL_ID, message, { parse_mode: 'HTML' });
        logger.info("Text-only message sent");
    } catch (e) {
        logger.error(`Failed to send text-only message: ${e.message}`);
    }
}

async function calculate24hVolume(transactions, decimals = Config.FALLBACK_DECIMALS) {
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 24 * 3600;
    let volume = 0.0;
    
    for (const tx of transactions) {
        if (Number(tx.timeStamp) >= oneDayAgo) {
            let amount = tx.value ? Number(BigInt(tx.value) / BigInt(10 ** Number(decimals))) : 0.0;
            if (amount === 0.0) {
                amount = await getTransferEventValue(tx.hash, decimals);
            }
            volume += amount;
        }
    }
    
    logger.info(`Calculated 24h volume: ${volume.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    return volume;
}

async function main() {
    logger.info("Starting token monitoring service...");
    
    if (!(await w3.eth.net.isListening())) {
        logger.error("Failed to connect to BSC node");
        process.exit(1);
    }

    const cache = new Cache();
    await cache.loadCache();
    logger.info(`Cache initialized: last_tx_hash=${cache.lastTxHash}, known_addresses=${cache.knownAddresses.size}`);
    
    const [name, symbol, initialSupply, decimals] = await getTokenInfo();
    logger.info(`Token info fetched: name=${name}, symbol=${symbol}, initial_supply=${initialSupply}, decimals=${decimals}`);
    let volume24h = 0;

    while (true) {
        try {
            logger.debug("Starting main loop iteration");
            const transactions = await getTokenTransactions();
            const price = await tokenPricePerUSD();
            logger.info(`Price fetched: ${price}`);
            volume24h = await calculate24hVolume(transactions, decimals);

            if (transactions.length) {
                logger.info(`Processing ${transactions.length} successful transactions`);
                for (const tx of transactions.slice(0, 5)) {
                    logger.info(`Transaction: ${tx.hash}, From: ${tx.from || 'N/A'}, To: ${tx.to || 'N/A'}, Value: ${tx.value || 'N/A'}, Time: ${tx.timeStamp || 'N/A'}`);
                }
                
                const latestTx = transactions[0];
                if (latestTx.hash !== cache.lastTxHash) {
                    logger.info(`New successful transaction detected: ${latestTx.hash}`);
                    await sendToTelegram(latestTx, initialSupply, price, name, symbol, decimals, volume24h, cache);
                    cache.lastTxHash = latestTx.hash;
                    await cache.saveCache();
                } else {
                    logger.info("No new successful transactions");
                }
            } else {
                logger.info("No successful transactions found in this iteration");
            }

            await new Promise(resolve => setTimeout(resolve, Config.POLLING_INTERVAL * 1000));
        } catch (e) {
            logger.error(`Main loop error: ${e.message}`);
            await new Promise(resolve => setTimeout(resolve, Config.POLLING_INTERVAL * 1000));
        }
    }
}

main().catch(e => logger.error(`Fatal error: ${e.message}`));