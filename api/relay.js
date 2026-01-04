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

    // 2. CONFIG - URL & API KEY
    const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    // 3. Ambil Parameter
    const finalParams = { ...req.query, ...req.body };
    const { action, apikey, ...dataParams } = finalParams; 

    let path = "";
    let method = "GET";
    let finalBody = null; 

    // 4. Routing Logic (PERBAIKAN DISINI)
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
            // [FIX] Mengubah endpoint dari /transaction ke /trx (GET)
            // Banyak server H2H menggunakan /trx untuk cek status juga
            path = "/trx"; 
            method = "GET";
            
            // Kirim kedua parameter ID untuk jaga-jaga
            dataParams.ref_id_custom = dataParams.refid;
            // Jangan delete dataParams.refid, biarkan terkirim double agar server memilih salah satu
            break;

        default:
            path = "/products"; 
    }

    // 5. Susun URL Target
    const targetUrl = new URL(BASE_URL + path);
    targetUrl.searchParams.append('apikey', API_KEY); 

    // [FIX] Header Penyamaran agar tidak diblokir (Solusi Stok Kosong)
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://ics-store.my.id/', 
            'Origin': 'https://ics-store.my.id'
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
        console.log(`[Relay] Requesting: ${targetUrl.toString()}`);
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // Cek jika server error (Balikan HTML)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            
            // Analisis Error HTML
            let msg = 'Server Pusat Error/Maintenance (HTML).';
            if(text.includes('404')) msg = 'Endpoint API Salah (404).';
            
            return res.status(502).json({ 
                success: false, 
                message: msg,
                raw: text.substring(0, 150)
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