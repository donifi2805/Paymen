export default async function handler(req, res) {
    // 1. Setup CORS (Agar bisa diakses dari browser)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. Konfigurasi Khusus KHFY
    const API_KEY = "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
    const BASE_URL = "https://panel.khfy-store.com/api_v2";

    // 3. Ambil Parameter
    // Gunakan req.query (GET) atau req.body (POST) tergantung request
    const paramsSource = req.method === 'POST' ? req.body : req.query;
    const finalParams = { ...paramsSource };

    // PENTING: Pisahkan parameter sistem. 
    // Kita BUANG 'api_key' bawaan dari frontend agar tidak bentrok (Double Key).
    const { endpoint, _t, api_key, ...dataParams } = finalParams; 

    if (!endpoint) return res.status(400).json({ success: false, message: 'Endpoint required' });

    // 4. Konstruksi URL
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const targetUrl = new URL(BASE_URL + cleanEndpoint);
    
    // Pasang API Key Server
    targetUrl.searchParams.append("api_key", API_KEY);

    // Masukkan sisa parameter data
    Object.keys(dataParams).forEach(key => {
        targetUrl.searchParams.append(key, dataParams[key]);
    });

    // 5. Eksekusi Request ke KHFY
    try {
        console.log(`[Relay KHFY] Fetching: ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), {
            method: req.method === 'POST' ? 'POST' : 'GET',
            headers: { 'User-Agent': 'PandawaRelay/Vercel' }
        });

        const text = await response.text();

        // Validasi HTML Error (Biasanya kalau server pusat down)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            return res.status(502).json({ 
                success: false, 
                message: 'HTML Error: Server Pusat Sedang Gangguan', 
                raw: text.substring(0, 50) 
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid JSON', raw: text });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}