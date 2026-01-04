export default async function handler(req, res) {
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

    // Pastikan API Key ini sesuai dengan milik Anda
    const API_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77";
    const BASE_URL = "https://api.ics-store.my.id/api/reseller";

    const finalParams = { ...req.query, ...req.body };
    const { action, ...dataParams } = finalParams; 

    let path = "";
    let method = "GET";
    let finalBody = null; 

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
            // Mapping refid agar dikenali server ICS sebagai ref_id_custom
            dataParams.ref_id_custom = dataParams.refid;
            break;

        default:
            path = "/products"; 
    }

    const targetUrl = new URL(BASE_URL + path);
    targetUrl.searchParams.append('apikey', API_KEY); 

    const fetchOptions = {
        method: method,
        headers: {
            'User-Agent': 'Pandawa-Relay/1.0',
            'Accept': 'application/json',
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

    try {
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();

        if (text.trim().startsWith('<')) {
            return res.status(502).json({ success: false, message: 'Server API memberikan respon HTML (Error/Maintenance).' });
        }

        const json = JSON.parse(text);
        return res.status(200).json(json);

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}