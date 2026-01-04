export default async function handler(req, res) {
    // 1. CORS Headers - Mengizinkan akses dari semua domain (*)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    // Handle Preflight Request
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- KONFIGURASI API ---
    // API Key sesuai file yang Anda upload
    const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    // 2. Ambil Parameter (Gabung query URL dan Body JSON)
    const finalParams = { ...req.query, ...req.body };
    const { action, _t, ...dataParams } = finalParams; 

    // 3. SMART ROUTING & MAPPING
    let path = "";
    let method = "GET";
    let finalBody = {}; 

    switch (action) {
        case 'listProducts':
            path = "/products"; 
            method = "GET";
            // [FIX V9] Kita JANGAN hapus dataParams.type agar filter (XLA/XDA) dari frontend terbaca server
            break;

        case 'createTransaction':
            path = "/trx"; 
            method = "POST";
            // Mapping parameter frontend ke parameter backend ICS
            finalBody = {
                product_code: dataParams.kode_produk || dataParams.product_code,
                dest_number: dataParams.nomor_tujuan || dataParams.dest_number,
                ref_id_custom: dataParams.refid || dataParams.ref_id_custom
            };
            break;

        case 'checkTransaction':
            // Endpoint untuk cek status transaksi berdasarkan refid
            path = "/transaction"; 
            method = "GET";
            break;

        case 'profile':
            path = "/profile"; 
            method = "GET";
            break;

        default:
            // Default fallback ke list produk jika action tidak dikenali
            path = "/products"; 
    }

    // 4. Susun URL Target
    const targetUrl = new URL(BASE_URL + path);
    
    // [PENTING] Selalu kirim API Key via URL parameter (Wajib untuk beberapa endpoint GET)
    targetUrl.searchParams.append('apikey', API_KEY); 

    // 5. Setup Fetch Options
    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Vercel-Relay/9.0', // Versi Bot
            'Accept': 'application/json',
            // Kirim API Key juga via Header sebagai cadangan auth
            'Authorization': `Bearer ${API_KEY}`
        }
    };

    if (method === 'GET') {
        // Untuk GET, masukkan semua parameter sisa ke URL Query
        Object.keys(dataParams).forEach(key => {
            targetUrl.searchParams.append(key, dataParams[key]);
        });
    } else {
        // Untuk POST, gunakan Body JSON
        fetchOptions.headers['Content-Type'] = 'application/json';
        // Gunakan finalBody yang sudah dimapping jika ada, jika tidak gunakan raw params
        fetchOptions.body = JSON.stringify(Object.keys(finalBody).length > 0 ? finalBody : dataParams);
    }

    try {
        // Log untuk debugging di dashboard Vercel
        console.log(`[Relay V9] ${method} ${targetUrl.toString()}`);
        
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        // 6. Validasi Response (Cek apakah HTML Error/Maintenance)
        if (text.trim().startsWith('<')) {
            console.error("[Relay HTML Error]", text.substring(0, 100));
            return res.status(502).json({
                success: false,
                message: 'Server Error (HTML). Endpoint Salah atau Maintenance.',
                raw: text.substring(0, 100)
            });
        }

        // 7. Parse JSON dan Return ke Frontend
        try {
            const json = JSON.parse(text);
            // Teruskan status code asli dari server pusat
            return res.status(response.ok ? 200 : response.status).json(json);
        } catch (e) {
            console.error("[Relay Parse Error]", text);
            return res.status(500).json({ success: false, message: 'Invalid JSON Response', raw: text });
        }

    } catch (error) {
        console.error("[Relay Sys Error]", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}