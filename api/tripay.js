export default async function handler(req, res) {
  // 1. Setup CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Callback-Event');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ==================================================================
  // DATA RAHASIA (HARDCODED)
  // ==================================================================
  const apiKey = 'hb5IS1m6ETmf15qHZtpXwd60w5K08myh'; 
  const pin = '0502'; 
  // ==================================================================
  
  // URL API BASE
  const apiBaseUrl = 'https://tripay.id/api/v2';

  try {
    // Handler Callback TriPay
    if (req.headers['x-callback-event'] || (req.body && req.body.id && req.body.status)) {
        return res.status(200).json({ success: true, message: 'Callback received OK' });
    }

    // Ambil parameter dari frontend
    // Menambahkan 'trxid' dan 'api_trxid' untuk fitur detail
    const { action, code, dest, reff_id, category_id, operator_id, trxid, api_trxid } = req.body || {};

    // ==================================================================
    // 1. CEK SERVER
    // ==================================================================
    if (action === 'cekserver') {
      const response = await fetch(`${apiBaseUrl}/cekserver`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 2. CEK KATEGORI
    // ==================================================================
    if (action === 'category') {
      let url = `${apiBaseUrl}/pembelian/category`;
      if (category_id) url += `?category_id=${category_id}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 3. CEK OPERATOR
    // ==================================================================
    if (action === 'operator') {
      let url = `${apiBaseUrl}/pembelian/operator`;
      const params = new URLSearchParams();
      if (category_id) params.append('category_id', category_id);
      if (operator_id) params.append('operator_id', operator_id);
      if (params.toString()) url += `?${params.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 4. CEK DAFTAR PRODUK (Pricelist)
    // ==================================================================
    if (action === 'pricelist') {
      const response = await fetch(`${apiBaseUrl}/pembelian/produk`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 5. CEK SALDO (Profile)
    // ==================================================================
    if (action === 'profile') {
      const response = await fetch(`${apiBaseUrl}/pembelian/profile`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 6. RIWAYAT TRANSAKSI (SEMUA)
    // ==================================================================
    if (action === 'history') {
      const response = await fetch(`${apiBaseUrl}/histori/transaksi/all`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const data = await response.json();
      return res.status(200).json(data);
    }

    // ==================================================================
    // 7. DETAIL TRANSAKSI (FITUR BARU)
    // Endpoint: https://tripay.id/api/v2/histori/transaksi/detail
    // ==================================================================
    if (action === 'detail') {
      // Validasi: Harus ada salah satu ID
      if (!trxid && !api_trxid) {
         return res.status(400).json({ 
            success: false, 
            message: 'Butuh trxid (TriPay) atau api_trxid (Lokal) untuk cek detail.' 
         });
      }

      // Menyusun Payload
      const payload = {};
      if (trxid) payload.trxid = trxid;
      if (api_trxid) payload.api_trxid = api_trxid;

      // Convert ke format form-urlencoded
      const formData = new URLSearchParams();
      for (const key in payload) {
          formData.append(key, payload[key]);
      }

      const response = await fetch(`${apiBaseUrl}/histori/transaksi/detail`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
      });

      const result = await response.json();
      return res.status(200).json(result);
    }

    // ==================================================================
    // 8. REQUEST TRANSAKSI
    // ==================================================================
    if (action === 'trx') {
      if (!code || !dest || !reff_id) {
        return res.status(400).json({ 
          success: false, 
          message: 'Data transaksi tidak lengkap (code/dest/reff_id missing)' 
        });
      }

      const isPln = code.toUpperCase().includes('PLN') || category_id === 'PLN'; 
      const inquiryType = isPln ? 'PLN' : 'I';

      const payload = {
        inquiry: inquiryType,
        code: code,
        phone: dest,
        api_trxid: reff_id,
        pin: pin
      };

      if (isPln) {
          payload.no_meter_pln = dest; 
      }

      const formData = new URLSearchParams();
      for (const key in payload) {
          formData.append(key, payload[key]);
      }

      const response = await fetch(`${apiBaseUrl}/transaksi/pembelian`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
      });

      const result = await response.json();

      if (result.success === false) { 
           return res.status(200).json({
               success: false,
               message: result.message || 'Transaksi Gagal dari Pusat',
               data: result
           });
      }

      return res.status(200).json(result);
    }

    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });

  } catch (error) {
    console.error("TriPay Error:", error);
    return res.status(500).json({ success: false, message: 'Server Error: ' + error.message });
  }
}