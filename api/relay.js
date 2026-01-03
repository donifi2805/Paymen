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

    // 3. SMART ROUTING (MAPPING SESUAI DOKUMENTASI TERBARU)
    let path = "";
    let method = "GET";
    let finalBody = {}; // Wadah untuk body JSON yang sudah dirapikan

    switch (action) {
        case 'listProducts':
            path = "/products"; 
            method = "GET";
            // Hapus filter type agar relay menarik semua data
            delete dataParams.type;
            break;

        case 'createTransaction':
            path = "/trx"; // Endpoint Baru
            method = "POST";
            
            // --- RE-MAPPING PARAMETER (PENTING) ---
            // Mengubah format lama (Frontend) ke format baru (ICS)
            finalBody = {
                product_code: dataParams.kode_produk || dataParams.product_code,
                dest_number: dataParams.nomor_tujuan || dataParams.dest_number,
                ref_id_custom: dataParams.refid || dataParams.ref_id_custom
            };
            break;

        case 'checkTransaction':
            path = "/status"; // Sesuaikan jika ada doku cek status
            method = "POST";
            finalBody = {
                ref_id_custom: dataParams.refid || dataParams.ref_id_custom
            };
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
    // Tetap sertakan API Key di URL sebagai cadangan
    targetUrl.searchParams.append('apikey', API_KEY); 

    // 5. Setup Fetch
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/7.0',
            'Accept': 'application/json',
            'Authorization': `Bearer ${API_KEY}` // Wajib Token
        }
    };

    // Masukkan Parameter Data
    if (method === 'GET') {
        Object.keys(dataParams).forEach(key => {
            targetUrl.searchParams.append(key, dataParams[key]);
        });
    } else {
        fetchOptions.headers['Content-Type'] = 'application/json';
        // Gunakan finalBody yang sudah diremap jika ada, jika tidak gunakan dataParams asli
        fetchOptions.body = JSON.stringify(Object.keys(finalBody).length > 0 ? finalBody : dataParams);
    }

    try {
        console.log(`[Relay V7] ${method} ${targetUrl.toString()}`);
        if(method === 'POST') console.log("Payload:", fetchOptions.body);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

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