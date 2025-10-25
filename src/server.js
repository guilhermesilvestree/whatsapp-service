// src/server.js
require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/database');
const { initializeMongoStore } = require('./services/whatsapp.client');

const PORT = process.env.PORT || 3002; // Usa a porta do .env ou 3002 como padrão

// Função principal assíncrona para lidar com a inicialização
const startServer = async () => {
    try {
        console.log('Iniciando WhatsApp Service...');

        // 1. Conectar ao Banco de Dados
        await connectDB();
        console.log('Conexão com MongoDB estabelecida.');

        // 2. Inicializar o MongoStore APÓS conectar ao DB
        if (!initializeMongoStore()) {
            console.error('Falha crítica ao inicializar MongoStore. Encerrando.');
            process.exit(1); // Encerra se o MongoStore não puder ser inicializado
        }
        console.log('MongoStore inicializado.');

        // 3. Iniciar o Servidor Express
        app.listen(PORT, () => {
            console.log(`Servidor WhatsApp Service rodando na porta ${PORT}`);
            console.log(`Aguardando requisições da API Principal em ${process.env.WHATSAPP_SERVICE_URL || `http://localhost:${PORT}`}`);
        });

        // Opcional: Tentar inicializar clientes existentes na inicialização?
        // Isso pode ser complexo e consumir recursos. Geralmente é melhor
        // inicializar sob demanda quando a API Principal solicita (QR code ou envio).

    } catch (error) {
        console.error('Falha ao iniciar o servidor:', error);
        process.exit(1); // Encerra o processo em caso de erro crítico na inicialização
    }
};

// Inicia o servidor
startServer();