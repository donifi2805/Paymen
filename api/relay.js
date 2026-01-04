export default async function handler(req, res) {
    // 1. CORS Headers - Mengizinkan akses dari frontend Anda
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

    // --- KONFIGURASI API (Ganti sesuai kredensial ICS Anda) ---
    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3";
    const BASE_URL = "https://reseller.ics-store.my.id";

    // 2. Normalisasi Parameter dari GET (query) atau POST (body)
    const finalParams = { ...req.query, ...req.body };
    const { action, ...dataParams } = finalParams; 

    let path = "";
    let method = "GET";
    let targetParams = new URLSearchParams();

    // 3. SMART MAPPING (Sinkronisasi dengan index.html)
    switch (action) {
        case 'listProducts':
            path = "/"; 
            method = "GET";
            targetParams.append('action', 'listProducts');
            if (dataParams.type) targetParams.append('type', dataParams.type);
            break;

        case 'createTransaction':
            path = "/"; 
            method = "GET"; // ICS API versi ini seringkali menggunakan GET untuk create
            targetParams.append('action', 'createTransaction');
            // Mapping dari frontend (kode_produk) ke backend (kode_produk)
            targetParams.append('kode_produk', dataParams.kode_produk || dataParams.product_code);
            targetParams.append('nomor_tujuan', dataParams.nomor_tujuan || dataParams.dest_number);
            targetParams.append('refid', dataParams.refid || dataParams.ref_id_custom);
            break;

        case 'checkTransaction':
            path = "/"; 
            method = "GET";
            targetParams.append('action', 'checkTransaction');
            targetParams.append('refid', dataParams.refid);
            break;

        default:
            path = "/";
            targetParams.append('action', 'listProducts');
    }

    // Selalu sertakan API Key di server-side agar aman
    targetParams.append('apikey', API_KEY);

    // 4. Bangun URL Target
    const targetUrl = `${BASE_URL}${path}?${targetParams.toString()}`;

    try {
        console.log(`[Relay-Safe] Routing: ${action} -> ${targetUrl}`);
        
        const response = await fetch(targetUrl, {
            method: method,
            headers: {
                'User-Agent': 'Pandawa-Relay-Server/1.0',
                'Accept': 'application/json'
            }
        });

        const text = await response.text();

        // 5. Validasi jika respon bukan JSON (misal HTML Maintenance)
        if (text.trim().startsWith('<')) {
            return res.status(502).json({
                success: false,
                message: 'Server ICS sedang maintenance atau memblokir akses.',
                raw_preview: text.substring(0, 100)
            });
        }

        const json = JSON.parse(text);
        return res.status(200).json(json);

    } catch (error) {
        console.error("[Relay-Error]", error);
        return res.status(500).json({ success: false, message: "Koneksi ke API Pusat gagal." });
    }
}