export default async function handler(req, res) {
    // 1. CORS Headers (Wajib)
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
    // Gunakan URL yang sudah terbukti WORK:
    const BASE_URL = "https://api.ics-store.my.id/api/reseller"; 

    // 2. Ambil Parameter
    const finalParams = { ...req.query, ...req.body };
    const { action, _t, ...dataParams } = finalParams; 

    // 3. Routing Sederhana (Fokus ke /products)
    let path = "/products"; // Default ke produk karena ini yang paling sering gagal
    let method = "GET";

    if (action === 'createTransaction') {
        path = "/process"; 
        method = "POST";
    } else if (action === 'checkTransaction') {
        path = "/status";
        method = "POST";
    } else if (action === 'profile') {
        path = "/profile";
    }

    // 4. Eksekusi Request
    const targetUrl = new URL(BASE_URL + path);
    targetUrl.searchParams.append('apikey', API_KEY); // Legacy support

    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/6.0',
            'Accept': 'application/json',
            'Authorization': `Bearer ${API_KEY}` // Token Bearer (KUNCI SUKSES)
        }
    };

    if (method === 'GET') {
        // Teruskan semua parameter filter (seperti type, code, dll)
        Object.keys(dataParams).forEach(key => targetUrl.searchParams.append(key, dataParams[key]));
    } else {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(dataParams);
    }

    try {
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();
        
        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            // Jika bukan JSON, kirim raw text untuk debug
            return res.status(500).json({ success: false, message: 'Invalid JSON', raw: text });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}