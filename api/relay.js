export default async function handler(req, res) {
    // 1. Setup CORS (SELALU DI ATAS)
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

    // WRAPPER ANTI-CRASH (GLOBAL TRY-CATCH)
    try {
        // 2. CONFIG
        const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
        const BASE_URL = "https://api.ics-store.my.id/api/reseller";

        // 3. Ambil Parameter
        const finalParams = { ...req.query, ...req.body };
        const { action, apikey, ...dataParams } = finalParams; 

        let path = "";
        let method = "GET";
        let finalBody = null; 

        // 4. Routing Logic
        switch (action) {
            case 'listProducts':
                path = "/products";
                method = "GET";
                break;

            case 'createTransaction':
                path = "/trx"; 
                method = "POST";
                finalBody = {
                    product_code: dataParams.kode_produk,
                    dest_number: dataParams.nomor_tujuan,
                    ref_id_custom: dataParams.refid
                };
                break;

            case 'checkTransaction':
                // Format URL: /trx/TRX_ID
                const trxId = dataParams.refid || dataParams.ref_id_custom;
                if (!trxId) return res.status(400).json({ success: false, message: 'RefID wajib ada.' });

                path = `/trx/${trxId}`; 
                method = "GET";
                
                // Bersihkan param agar tidak duplikat
                delete dataParams.refid;
                delete dataParams.ref_id_custom;
                break;

            default:
                path = "/products"; 
        }

        // 5. Susun URL Target
        const targetUrl = new URL(BASE_URL + path);
        // Tetap kirim apikey di URL untuk jaga-jaga (Hybrid Auth)
        targetUrl.searchParams.append('apikey', API_KEY); 

        // [FIX UTAMA] Tambahkan Header Authorization (Bearer Token) + User-Agent
        const fetchOptions = {
            method: method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Connection': 'keep-alive',
                // INI YANG DIBUTUHKAN SERVER (Mengatasi "Unauthorized: No Token")
                'Authorization': `Bearer ${API_KEY}`
            }
        };

        if (method === 'GET') {
            Object.keys(dataParams).forEach(key => {
                targetUrl.searchParams.append(key, dataParams[key]);
            });
        } else {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(finalBody || dataParams);
        }

        console.log(`[Relay] Requesting: ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Handle Error HTML (502/404/500)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            return res.status(502).json({ 
                success: false, 
                message: 'Gagal komunikasi dengan Server Pusat (Respon HTML).',
                raw: text.substring(0, 150)
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Respon server bukan JSON.', raw: text.substring(0, 100) });
        }

    } catch (criticalError) {
        // GLOBAL CATCH: Menangkap semua error logic/syntax agar tidak crash tanpa respon
        console.error("[Critical Relay Error]", criticalError);
        return res.status(500).json({ 
            success: false, 
            message: "Internal Relay Error: " + criticalError.message 
        });
    }
}