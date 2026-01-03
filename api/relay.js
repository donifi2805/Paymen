export default async function handler(req, res) {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- KONFIGURASI BARU (SESUAI REQUEST ANDA) ---
    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3"; 
    // Base URL diarahkan ke endpoint API yang benar
    const BASE_URL = "https://api.ics-store.my.id/api/reseller"; 

    // 2. Ambil Parameter
    const queryParams = req.query || {};
    const bodyParams = req.body || {};
    const finalParams = { ...queryParams, ...bodyParams };
    const action = finalParams.action;

    if (!action) {
        return res.status(400).json({ success: false, message: 'Action missing' });
    }

    // 3. Susun URL Target (Smart Mapping)
    // Beberapa API menggunakan ?action=..., ada juga yang menggunakan path /products
    // Kita gunakan standar Query String dulu karena paling umum untuk H2H
    const targetUrl = new URL(BASE_URL);
    
    // Masukkan semua parameter
    targetUrl.searchParams.append('apikey', API_KEY);
    Object.keys(finalParams).forEach(key => {
        if (key !== 'apikey' && key !== '_t') {
            targetUrl.searchParams.append(key, finalParams[key]);
        }
    });

    try {
        console.log(`[Relay] Requesting to: ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'User-Agent': 'Vercel-Relay/1.0',
                'Accept': 'application/json'
            }
        });

        const text = await response.text();
        
        // Cek jika respon adalah HTML (Tanda salah alamat/maintenance)
        if (text.trim().startsWith('<')) {
            console.error("[Relay Error] Received HTML instead of JSON:", text.substring(0, 100));
            return res.status(502).json({ 
                success: false, 
                message: 'Server ICS merespon dengan HTML (Mungkin salah URL atau sedang Maintenance).',
                raw: text.substring(0, 200)
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            console.error("[Relay Error] Invalid JSON:", text);
            return res.status(500).json({ success: false, message: 'Respon server bukan JSON valid', raw: text });
        }

    } catch (error) {
        console.error("[Relay Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
