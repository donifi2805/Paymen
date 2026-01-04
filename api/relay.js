export default async function handler(req, res) {
    // 1. Konfigurasi CORS - Mengizinkan akses dari domain aplikasi Anda
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    // Menangani Preflight Request (OPTIONS)
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- KREDENSIAL SERVER (Tersembunyi dari sisi client) ---
    // Gunakan API Key ICS Store Anda di sini
    const API_KEY = "dcc0a69aa74abfde7b1bc5d252d858cb2fc5e32192da06a3"; 
    const BASE_URL = "https://reseller.ics-store.my.id";

    // 2. Normalisasi Parameter (Menggabungkan Query URL dan Body JSON)
    const finalParams = { ...req.query, ...req.body };
    const { action, ...dataParams } = finalParams; 

    let targetParams = new URLSearchParams();
    
    // Selalu sertakan API Key pada setiap permintaan ke server pusat
    targetParams.append('apikey', API_KEY);

    // 3. SMART ROUTING (Mencocokkan action dari frontend index.html)
    switch (action) {
        case 'listProducts':
            targetParams.append('action', 'listProducts');
            if (dataParams.type) targetParams.append('type', dataParams.type);
            break;

        case 'createTransaction':
            targetParams.append('action', 'createTransaction');
            // Mapping parameter dari frontend (kode_produk, nomor_tujuan, refid)
            targetParams.append('kode_produk', dataParams.kode_produk || dataParams.product_code);
            targetParams.append('nomor_tujuan', dataParams.nomor_tujuan || dataParams.dest_number);
            targetParams.append('refid', dataParams.refid || dataParams.ref_id_custom);
            break;

        case 'checkTransaction':
            targetParams.append('action', 'checkTransaction');
            targetParams.append('refid', dataParams.refid);
            break;

        default:
            targetParams.append('action', 'listProducts');
    }

    // 4. Membangun URL Target Akhir
    const targetUrl = `${BASE_URL}/?${targetParams.toString()}`;

    try {
        console.log(`[Relay-ICS] Action: ${action} | URL: ${targetUrl}`);
        
        const response = await fetch(targetUrl, {
            method: 'GET', // ICS API menggunakan metode GET untuk sebagian besar perintah
            headers: {
                'User-Agent': 'Pandawa-Relay-V3/1.1',
                'Accept': 'application/json'
            }
        });

        const text = await response.text();

        // 5. Validasi apakah respon adalah HTML (Indikasi Maintenance/Error Server Pusat)
        if (text.trim().startsWith('<')) {
            console.error("[Relay-Error] Respon HTML terdeteksi");
            return res.status(502).json({
                success: false,
                message: 'Server pusat sedang maintenance atau memberikan respon tidak valid.',
                preview: text.substring(0, 100)
            });
        }

        // 6. Mengirimkan data kembali ke Frontend
        try {
            const json = JSON.parse(text);
            return res.status(200).json(json);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Gagal memproses data JSON dari server pusat.' });
        }

    } catch (error) {
        console.error("[Relay-System-Error]", error);
        return res.status(500).json({ success: false, message: "Koneksi ke server relay atau pusat terputus." });
    }
}