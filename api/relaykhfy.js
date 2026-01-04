export default async function handler(req, res) {
    // 1. Setup CORS (Agar bisa diakses dari Panel Admin)
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
    const finalParams = { ...req.query, ...req.body };
    const { endpoint, _t, ...dataParams } = finalParams; 

    if (!endpoint) return res.status(400).json({ success: false, message: 'Endpoint required (e.g., /trx)' });

    // 4. Konstruksi URL
    // Format: BASE_URL + endpoint + ?api_key=...
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const targetUrl = new URL(BASE_URL + cleanEndpoint);
    targetUrl.searchParams.append("api_key", API_KEY);

    // Masukkan sisa parameter (produk, tujuan, reff_id, dll)
    Object.keys(dataParams).forEach(key => {
        targetUrl.searchParams.append(key, dataParams[key]);
    });

    // 5. Eksekusi Request ke KHFY
    try {
        console.log(`[Relay KHFY] Fetching: ${targetUrl.toString()}`);
        const response = await fetch(targetUrl.toString(), {
            method: req.method === 'POST' ? 'POST' : 'GET',
            headers: { 'User-Agent': 'RelayKHFY/1.0' }
        });

        const text = await response.text();

        // Validasi HTML Error
        if (text.trim().startsWith('<')) {
            return res.status(502).json({ 
                success: false, 
                message: 'HTML Error dari Pusat (KHFY Sedang Gangguan/Maintenance)', 
                raw: text.substring(0, 100) 
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid JSON Response', raw: text });
        }

    } catch (error) {
        return res.status(500).json({ success: false, message: 'Relay System Error: ' + error.message });
    }
}
