// src/utils/admin.auth.middleware.js
exports.verifyAdminKey = (req, res, next) => {
    const adminKey = req.headers['x-admin-api-key'];
    const expectedKey = process.env.ADMIN_API_KEY;
  
    if (!expectedKey) {
      console.error("ADMIN_API_KEY não está definido no .env. Rota admin desabilitada.");
      return res.status(500).json({ message: "Configuração de admin incompleta." });
    }
  
    if (!adminKey || adminKey !== expectedKey) {
      return res.status(401).json({ message: 'Não autorizado. Chave de API admin inválida.' });
    }
  
    next();
  };