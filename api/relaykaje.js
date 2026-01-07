// File: api/relaykaje.js

// PERSIAPAN:
// Pastikan Anda sudah menginstall package yang dibutuhkan.
// Buka terminal, ketik: npm init -y && npm install express axios cors body-parser

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const port = 3000; // Port server

// Konfigurasi Kaje Store
const API_CONFIG = {
    baseUrl: 'https://end.kaje-store.com/api',
    apiKey: '8eb9026f46a9ebed7c3de2292bd6353fea402c2ae8328f04b728f879a963' // API Key Anda (Aman disini, tidak terlihat user)
};

// Middleware
app.use(cors()); // Mengizinkan akses dari frontend
app.use(express.json()); // Membaca data JSON dari frontend

// --- ROUTE UTAMA ---
app.post('/api/relaykaje', async (req, res) => {
    const { action, payload } = req.body;

    try {
        let targetUrl = '';
        let requestBody = {};

        // 1. Logika percabangan berdasarkan aksi dari frontend
        if (action === 'saldo') {
            targetUrl = `${API_CONFIG.baseUrl}/info/saldo`;
            requestBody = {}; // Body kosong sesuai dokumentasi Kaje
        } 
        // 2. Siapkan tempat untuk fitur lain (Pricelist/Transaksi) nanti
        else if (action === 'transaksi') {
            // Nanti diisi endpoint transaksi
             return res.status(400).json({ success: false, message: 'Fitur belum aktif' });
        }
        else {
            return res.status(400).json({ success: false, message: 'Action tidak dikenali' });
        }

        // 3. Tembak ke API Kaje Store
        const response = await axios.post(targetUrl, requestBody, {
            headers: {
                'x-api-key': API_CONFIG.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // 4. Kirim balik respon asli dari Kaje ke Frontend
        res.json(response.data);

    } catch (error) {
        console.error("Relay Error:", error.message);
        // Handle error jika API Kaje down atau error
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ success: false, message: 'Internal Server Error' });
        }
    }
});

// Jalankan Server
app.listen(port, () => {
    console.log(`Server Relay berjalan di http://localhost:${port}`);
    console.log(`Endpoint siap di: http://localhost:${port}/api/relaykaje`);
});
