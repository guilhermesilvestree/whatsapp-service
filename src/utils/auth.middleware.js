// src/utils/auth.middleware.js
const jwt = require('jsonwebtoken');

exports.verifyServiceToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  let token;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Não autorizado, token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.WHATSAPP_SERVICE_JWT_SECRET);

    // Verifica se o token foi emitido pela api-clinic (opcional, mas bom)
    if (decoded.iss !== 'api-clinic') {
       throw new Error('Emissor do token inválido.');
    }

    // Adiciona o clinicId à requisição para ser usado pelos controllers
    if (!decoded.clinicId) {
        throw new Error('Token não contém clinicId.');
    }
    req.clinicId = decoded.clinicId;

    next();
  } catch (error) {
    console.error("Erro na verificação do token de serviço:", error.message);
    return res.status(401).json({ message: 'Não autorizado, token inválido ou expirado.' });
  }
};