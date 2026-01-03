export default async function handler(req, res) {
    // Header CORS agar frontend bisa akses
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3"; // API Key ICS Anda
    const BASE_URL = "https://reseller.ics-store.my.id";

    // Ambil parameter dari query URL (untuk GET) atau Body (untuk POST)
    const { action, ...otherParams } = req.query; // Ambil action dari URL
    
    // Jika tidak ada action di query, coba cari di body (untuk POST)
    let finalAction = action;
    let finalParams = { ...otherParams };

    if (!finalAction && req.body && req.body.action) {
        finalAction = req.body.action;
        // Gabungkan body params
        finalParams = { ...finalParams, ...req.body };
    }

    if (!finalAction) {
        return res.status(400).json({ success: false, message: 'Action missing' });
    }

    // Susun URL Target ke ICS
    const targetUrl = new URL(BASE_URL);
    targetUrl.searchParams.append('apikey', API_KEY);
    targetUrl.searchParams.append('action', finalAction);

    // Tambahkan parameter lain ke URL (ICS biasanya menerima param via GET query string bahkan untuk POST)
    Object.keys(finalParams).forEach(key => {
        if(key !== 'action' && key !== 'apikey') {
            targetUrl.searchParams.append(key, finalParams[key]);
        }
    });

    try {
        console.log(`[Relay] Requesting to: ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), {
            method: 'GET', // ICS API mayoritas menerima GET atau POST query string
            headers: {
                'User-Agent': 'Mozilla/5.0 (Vercel-Relay/1.0)'
            }
        });

        const data = await response.text(); // Ambil text dulu, karena kadang ICS return HTML error
        
        try {
            const jsonData = JSON.parse(data);
            return res.status(200).json(jsonData);
        } catch (e) {
            console.error("JSON Parse Error:", data);
            // Jika ICS me-return string JSON di dalam field 'contents' (kasus jarang) atau error HTML
            return res.status(200).json({ success: false, message: 'Invalid JSON from ICS', raw: data });
        }

    } catch (error) {
        console.error("[Relay Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
