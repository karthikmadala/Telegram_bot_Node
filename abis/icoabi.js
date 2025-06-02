module.exports = [
    {
        "inputs":[],"name":"tokenAmountPerUSD","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"
    },
    {
        "inputs":[],"name":"tokenAddress","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"
    },
    {
        "inputs": [
            {"internalType": "address", "name": "recipient", "type": "address"},
            {"internalType": "uint256", "name": "paymentType", "type": "uint256"},
            {"internalType": "uint256", "name": "tokenAmount", "type": "uint256"},
            {
                "components": [
                    {"internalType": "uint8", "name": "v", "type": "uint8"},
                    {"internalType": "bytes32", "name": "r", "type": "bytes32"},
                    {"internalType": "bytes32", "name": "s", "type": "bytes32"},
                    {"internalType": "uint256", "name": "nonce", "type": "uint256"}
                ],
                "internalType": "struct StoneForm_ICO.Sign",
                "name": "sign",
                "type": "tuple"
            }
        ],
        "name": "buyToken","outputs": [],"stateMutability": "payable","type":"function"
    }
];