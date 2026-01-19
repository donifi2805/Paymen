export default async function handler(req, res) {
  // 1. Setup CORS (Agar bisa dipanggil dari frontend & menerima Callback TriPay)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Callback-Event');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ==================================================================
  // DATA RAHASIA (HARDCODED)
  // ==================================================================
  const apiKey = 'hb5IS1m6ETmf15qHZtpXwd60w5K08myh'; 
  const pin = '0502'; 
  // ==================================================================
  
  const baseUrl = 'https://tripay.co.id/api-v2/pembelian'; 

  try {
    // --- FITUR 0: HANDLER CALLBACK (PENTING AGAR URL BISA DISIMPAN DI DASHBOARD) ---
    // Jika TriPay mengirim data callback atau tes koneksi
    if (req.headers['x-callback-event'] || (req.body && req.body.id && req.body.status)) {
        return res.status(200).json({ success: true, message: 'Callback received OK' });
    }

    // Ambil data dari Request Frontend
    const { action, code, dest, reff_id } = req.body || {};

    // --- FITUR 1: CEK DAFTAR PRODUK (Pricelist) ---
    if (action === 'pricelist') {
      const response = await fetch(`${baseUrl}/produk`, {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${apiKey}` 
        }
      });
      
      const data = await response.json();
      return res.status(200).json(data);
    }

    // --- FITUR 2: CEK SALDO (Profile) ---
    if (action === 'profile') {
      const response = await fetch(`${baseUrl}/profile`, {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${apiKey}` 
        }
      });
      
      const data = await response.json();
      return res.status(200).json(data);
    }

    // --- FITUR 3: TRANSAKSI (Beli Pulsa/Data) ---
    if (action === 'trx') {
      // Validasi input
      if (!code || !dest || !reff_id) {
        return res.status(400).json({ 
          success: false, 
          message: 'Data transaksi tidak lengkap (code/dest/reff_id missing)' 
        });
      }

      // Payload sesuai dokumentasi TriPay PPOB
      const payload = {
        kode_produk: code,
        no_tujuan_utama: dest,
        no_tujuan_tambahan: dest, // Opsional
        api_trxid: reff_id,
        pin: pin // PIN 0502
      };

      const response = await fetch(`${baseUrl}/transaksi`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      // Normalisasi Respon: TriPay kadang merespon success: true tapi status transaksi 'gagal' (status: 2)
      if (result.success && result.data && result.data.status === 2) { 
           return res.status(200).json({
               success: false,
               message: result.data.pesan || 'Transaksi Gagal dari Pusat',
               data: result.data
           });
      }

      return res.status(200).json(result);
    }

    // Jika tidak ada action yang cocok
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });

  } catch (error) {
    console.error("TriPay Error:", error);
    return res.status(500).json({ success: false, message: 'Server Error: ' + error.message });
  }
}