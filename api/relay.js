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

    // 2. CONFIG - API KEY YANG BENAR
    const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    // 3. Bersihkan Parameter
    // Kita ambil 'action' dan buang 'apikey' bawaan frontend (jika ada) agar tidak duplikat
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
            // Pastikan mapping ID benar & hapus parameter lama
            dataParams.ref_id_custom = dataParams.refid;
            delete dataParams.refid; 
            break;

        default:
            path = "/products"; 
    }

    // 5. Susun URL Target
    const targetUrl = new URL(BASE_URL + path);
    // Masukkan API Key yang benar di sini
    targetUrl.searchParams.append('apikey', API_KEY); 

    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Pandawa-Relay/2.0',
            'Accept': 'application/json'
            // Header Authorization DIHAPUS agar tidak bentrok dengan URL param
        }
    };

    // Masukkan sisa parameter (dataParams) ke URL atau Body
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
            return res.status(502).json({ 
                success: false, 
                message: 'Server Pusat (ICS) sedang Maintenance/Error (HTML Response).',
                raw: text.substring(0, 100)
            });
        }

        const json = JSON.parse(text);
        
        // Selalu return 200 agar Frontend bisa membaca pesan error JSON-nya
        return res.status(200).json(json);

    } catch (error) {
        console.error("[Relay Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}