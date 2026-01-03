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
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    // 2. Ambil Parameter
    const finalParams = { ...req.query, ...req.body };
    const { action, _t, ...dataParams } = finalParams; 

    // 3. SMART ROUTING (PERBAIKAN ALAMAT)
    let path = "";
    let method = "GET";

    switch (action) {
        case 'listProducts':
            // PERBAIKAN: Gunakan Bahasa Inggris '/products'
            path = "/products"; 
            method = "GET";
            break;

        case 'createTransaction':
            // Coba endpoint standar transaksi
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
            // Jika action tidak dikenal, default ke products
            path = "/products"; 
    }

    // 4. Susun URL
    const targetUrl = new URL(BASE_URL + path);
    // Tetap sertakan apikey di URL untuk jaga-jaga
    targetUrl.searchParams.append('apikey', API_KEY); 

    // 5. Setup Fetch dengan AUTH TOKEN
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/5.0',
            'Accept': 'application/json',
            // Token Bearer (Wajib untuk API Baru)
            'Authorization': `Bearer ${API_KEY}`,
            // Header Tambahan (Opsional)
            'API-Key': API_KEY 
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
        console.log(`[Relay V5] ${method} ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Debug: Cek jika HTML (Salah Alamat)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            
            // FALLBACK KUAT: Jika /products gagal, coba root URL (gaya lama)
            if (path === "/products") {
                console.log("[Relay V5] Retrying with Legacy Path...");
                const retryUrl = new URL(BASE_URL); // Tanpa /products
                retryUrl.searchParams.append('apikey', API_KEY);
                retryUrl.searchParams.append('action', 'listProducts');
                
                // Coba fetch ulang tanpa header Bearer (gaya lama)
                const retryRes = await fetch(retryUrl.toString(), {
                   method: 'GET'
                });
                const retryText = await retryRes.text();
                try { return res.status(200).json(JSON.parse(retryText)); } catch(e) {}
            }

            return res.status(502).json({
                success: false,
                message: 'Server Error (HTML). Endpoint Salah.',
                raw: text.substring(0, 200)
            });
        }

        try {
            const json = JSON.parse(text);
            
            // DEBUG KHUSUS: Cek apakah data kosong?
            if (json.data && Array.isArray(json.data) && json.data.length === 0) {
                 console.warn("[Relay Warning] Data Kosong dari Pusat");
            }
            
            return res.status(response.ok ? 200 : response.status).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid JSON', raw: text });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}