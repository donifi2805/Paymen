export default async function handler(req, res) {
    // 1. Setup CORS
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

    // --- KONFIGURASI API ---
    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3";
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    // 2. Ambil Parameter (Gabung Query & Body)
    const finalParams = { ...req.query, ...req.body };
    const { action, _t, ...dataParams } = finalParams; // Pisahkan action & timestamp

    // 3. SMART ROUTING (MAPPING ACTION -> ENDPOINT REST)
    let path = "";
    let method = "GET"; // Default

    switch (action) {
        case 'listProducts':
            // Sesuai data yang Anda berikan: GET /reseller/products
            path = "/products"; 
            method = "GET";
            break;

        case 'createTransaction':
            // TEBAKAN LOGIS: Biasanya /process, /buy, atau /transaction
            // Jika nanti transaksi gagal, ganti "/process" dengan endpoint yang ada di dokumentasi ICS
            path = "/process"; 
            method = "POST";
            break;

        case 'checkTransaction':
            path = "/status"; // TEBAKAN
            method = "POST";
            break;

        default:
            // Fallback: Jika action tidak dikenal, kirim ke root (Support Legacy)
            path = ""; 
    }

    // 4. Susun URL Target
    const targetUrl = new URL(BASE_URL + path);
    targetUrl.searchParams.append('apikey', API_KEY); // API Key selalu di URL (sesuai log Anda)

    // 5. Siapkan Opsi Fetch
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/2.0',
            'Accept': 'application/json'
        }
    };

    // Masukkan Parameter Data
    if (method === 'GET') {
        // Untuk GET: Masukkan ke Query String URL
        Object.keys(dataParams).forEach(key => {
            targetUrl.searchParams.append(key, dataParams[key]);
        });
    } else {
        // Untuk POST: Masukkan ke Body JSON
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(dataParams);
    }

    try {
        console.log(`[Relay] Routing: ${action} -> ${method} ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Cek jika respon adalah HTML (Error 404/500 dari Server)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 150));
            return res.status(502).json({
                success: false,
                message: `Server ICS Error (HTML Response). Path '${path}' mungkin salah.`,
                raw: text.substring(0, 100) + "..."
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            console.error("[Relay Parse Error]", text);
            return res.status(500).json({ success: false, message: 'Respon API tidak valid (Bukan JSON)', raw: text });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}