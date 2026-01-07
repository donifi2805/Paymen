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

app.use(cors());
app.use(express.json());

// PERBAIKAN: Gunakan '*' agar cocok dengan path apapun yang dikirim Vercel
app.post('*', async (req, res) => {
    const { action } = req.body;

    // Debugging: Lihat apa yang diterima server di Log Vercel
    console.log("Request masuk:", action);

    try {
        let targetUrl = '';
        let requestBody = {};

        if (action === 'saldo') {
            targetUrl = `${API_CONFIG.baseUrl}/info/saldo`;
            requestBody = {}; 
        } else {
            return res.json({ success: false, message: 'Action tidak dikenali atau kosong' });
        }

        const response = await axios.post(targetUrl, requestBody, {
            headers: {
                'x-api-key': API_CONFIG.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        return res.json(response.data);

    } catch (error) {
        console.error("Relay Error:", error.message);
        const status = error.response ? error.response.status : 500;
        const data = error.response ? error.response.data : { success: false, message: error.message };
        return res.status(status).json(data);
    }
});

// PENTING: Jangan pakai app.listen()
module.exports = app;