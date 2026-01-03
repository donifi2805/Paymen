export default async function handler(req, res) {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- KONFIGURASI API ---
    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3";
    // Menggunakan endpoint sesuai dokumentasi Anda (/reseller/products)
    // Asumsi Base URL API adalah domain + /api
    const BASE_URL = "https://api.ics-store.my.id/api/reseller"; 

    // 2. Ambil Parameter
    const finalParams = { ...req.query, ...req.body };
    const { action, _t, ...dataParams } = finalParams; 

    // 3. SMART ROUTING
    let path = "";
    let method = "GET";

    switch (action) {
        case 'listProducts':
            // Sesuai data user: GET /reseller/products
            // Karena BASE_URL sudah /api/reseller, kita tambah /products
            path = "/products"; 
            method = "GET";
            
            // TRICK PENTING: Hapus parameter filter agar Server memberikan SEMUA data
            // Kita akan filter di Frontend saja (lebih aman dari salah ketik/case sensitive)
            delete dataParams.type;
            delete dataParams.category;
            break;

        case 'createTransaction':
            path = "/process"; 
            method = "POST";
            break;

        case 'checkTransaction':
            path = "/status"; 
            method = "POST";
            break;

        case 'profile':
            path = "/profile"; 
            method = "GET";
            break;

        default:
            path = "/products"; 
    }

    // 4. Susun URL
    const targetUrl = new URL(BASE_URL + path);
    
    // Cadangan API Key di URL (Legacy)
    targetUrl.searchParams.append('apikey', API_KEY); 

    // 5. Setup Fetch dengan AUTH TOKEN
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/6.0',
            'Accept': 'application/json',
            'Authorization': `Bearer ${API_KEY}` // Wajib untuk ICS Baru
        }
    };

    // Masukkan Parameter Data
    if (method === 'GET') {
        Object.keys(dataParams).forEach(key => {
            targetUrl.searchParams.append(key, dataParams[key]);
        });
    } else {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(dataParams);
    }

    try {
        console.log(`[Relay V6] ${method} ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Debug HTML Error
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            return res.status(502).json({
                success: false,
                message: 'Server Error (HTML). Endpoint Salah/Maintenance.',
                raw: text.substring(0, 100)
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(response.ok ? 200 : response.status).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid JSON', raw: text });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}