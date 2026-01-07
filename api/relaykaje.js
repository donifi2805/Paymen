// File: api/relaykaje.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

// Konfigurasi
const API_CONFIG = {
    baseUrl: 'https://end.kaje-store.com/api',
    apiKey: '8eb9026f46a9ebed7c3de2292bd6353fea402c2ae8328f04b728f879a963' 
};

// Middleware
app.use(cors());
app.use(express.json());

// Handler Utama
app.post('/api/relaykaje', async (req, res) => {
    const { action, payload } = req.body;

    try {
        let targetUrl = '';
        let requestBody = {};

        if (action === 'saldo') {
            targetUrl = `${API_CONFIG.baseUrl}/info/saldo`;
            requestBody = {}; 
        } else {
            return res.status(400).json({ success: false, message: 'Action tidak dikenali' });
        }

        const response = await axios.post(targetUrl, requestBody, {
            headers: {
                'x-api-key': API_CONFIG.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        res.json(response.data);

    } catch (error) {
        console.error("Relay Error:", error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ success: false, message: 'Internal Server Error' });
        }
    }
});

// PENTING UNTUK VERCEL:
// Jangan gunakan app.listen(). Gunakan export module.
module.exports = app;