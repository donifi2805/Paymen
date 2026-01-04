export default async function handler(req, res) {
    // 1. Setup CORS
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

    // 2. CONFIG - URL SESUAI INSTRUKSI ANDA
    const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
    // Menggunakan URL yang Anda konfirmasi benar
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
            path = "/transaction"; 
            method = "GET";
            // Mapping ID untuk cek status
            dataParams.ref_id_custom = dataParams.refid;
            delete dataParams.refid; 
            break;

        default:
            path = "/products"; 
    }

    // 5. Susun URL Target
    const targetUrl = new URL(BASE_URL + path);
    targetUrl.searchParams.append('apikey', API_KEY); 

    // [FIX PENTING] Menyamar sebagai Browser Chrome untuk hindari Error 502/Blokir
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Connection': 'keep-alive'
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

    try {
        console.log(`[Relay] Requesting to: ${targetUrl.toString()}`);
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Cek jika server error / maintenance (Balikan HTML)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            return res.status(502).json({ 
                success: false, 
                message: 'Server Pusat (ICS) Mengembalikan Error HTML (502). Coba cek API Key atau URL kembali.',
                raw: text.substring(0, 200)
            });
        }

        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Respon bukan JSON valid.', raw: text.substring(0, 100) });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}