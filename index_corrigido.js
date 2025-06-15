const wppconnect = require('@wppconnect-team/wppconnect');
const { io } = require("socket.io-client");
const axios = require('axios');
const fs = require('fs').promises; // Use promises for async file operations
const fsSync = require('fs'); // Use sync for initial checks/loads if needed
const path = require('path');
const { execFile } = require('child_process');

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fsSync.existsSync(TEMP_DIR)) {
    fsSync.mkdirSync(TEMP_DIR, { recursive: true });
}

// --- Configurações --- 
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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'; // Prefer environment variable
const IA_MODEL = process.env.IA_MODEL || 'meta-llama/llama-4-maverick:free';
const SESSION_NAME = process.env.SESSION_NAME || 'atendente-pop-session';
const DATA_DIR = path.join(__dirname, 'data');
const OFERTAS_DIR = path.join(__dirname, 'ofertas');
const USER_DATA_FILE = path.join(DATA_DIR, 'user_data.json'); // File for persistent user data
const TIMEZONE = 'America/Sao_Paulo';
const MAX_HISTORICO_MENSAGENS = 15;
const PAUSA_ENTRE_IMAGENS_MS = 1000;
// Número para notificar quando pedirem atendente (DEFINIR PELO USUÁRIO - Exemplo)
const NUMERO_ATENDENTE = process.env.NUMERO_ATENDENTE || null; // Ex: '5511999998888@c.us'

// --- Configurações da API Economiza Alagoas ---
const ECONOMIZA_ALAGOAS_TOKEN = process.env.ECONOMIZA_ALAGOAS_TOKEN || '0c80f47b7a0e3987fc8283c4a53e88c03191812a';
const ECONOMIZA_ALAGOAS_API_URL = 'http://api.sefaz.al.gov.br/sfz-economiza-alagoas-api/api/public/produto/pesquisa';
const ARAPIRACA_CODIGO_IBGE = '2700300';
const POPULAR_SUPERMERCADO_CNPJ = '07771407000161'; // CNPJ sem formatação para a API

// --- Estados da Conversa --- 
const Estados = {
    IDLE: 'IDLE', // Estado padrão
    AWAITING_NAME: 'AWAITING_NAME', // Aguardando nome após pergunta inicial
    PROCESSING_QUERY: 'PROCESSING_QUERY', // Processando consulta geral com IA
    PROCESSING_OFFER: 'PROCESSING_OFFER', // Processando pedido de ofertas
    PROCESSING_PRICE: 'PROCESSING_PRICE', // Processando consulta de preços
    AWAITING_HUMAN_CONFIRMATION: 'AWAITING_HUMAN_CONFIRMATION', // Aguardando confirmação para chamar atendente
    HUMAN_REQUESTED: 'HUMAN_REQUESTED' // Usuário pediu atendente, aguardando contato humano
};

// --- Funções de Transcrição de Áudio ---
const transcreverComAssemblyAI = async (caminhoAudio) => {
    const assemblyKey = '06cafbe793184fc088ac832f4c605d34';
    const uploadUrl = 'https://api.assemblyai.com/v2/upload';
    const transcribeUrl = 'https://api.assemblyai.com/v2/transcript';
    const buffer = await fs.readFile(caminhoAudio);

    // 1. Upload do áudio
    const uploadRes = await axios.post(uploadUrl, buffer, {
        headers: {
            'authorization': assemblyKey,
            'content-type': 'application/octet-stream'
        }
    });

    const audioUrl = uploadRes.data.upload_url;

    // 2. Requisição de transcrição
    const transcriptRes = await axios.post(transcribeUrl, {
        audio_url: audioUrl,
        language_code: 'pt'
    }, {
        headers: {
            'authorization': assemblyKey,
            'content-type': 'application/json'
        }
    });

    const transcriptId = transcriptRes.data.id;

    // 3. Esperar transcrição (pooling simples)
    const checkStatus = async () => {
        const result = await axios.get(`${transcribeUrl}/${transcriptId}`, {
            headers: { 'authorization': assemblyKey }
        });
        if (result.data.status === 'completed') return result.data.text;
        if (result.data.status === 'error') throw new Error(result.data.error);
        await new Promise(resolve => setTimeout(resolve, 2000)); // espera 2s
        return checkStatus();
    };

    return await checkStatus();
};

const transcreverComWhisperLocal = (caminhoAudio) => {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'transcrever.py');

        execFile('python', [scriptPath, caminhoAudio], (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erro ao executar Whisper local:', stderr);
                return reject(error);
            }
            resolve(stdout.trim());
        });
    });
};

// --- Gerenciamento de Dados Persistentes --- 
let userDataStore = {}; // Cache em memória dos dados dos usuários

/**
 * Carrega os dados dos usuários do arquivo JSON para a memória.
 */
const carregarDadosUsuarios = async () => {
    try {
        // Garante que o diretório de dados exista
        if (!fsSync.existsSync(DATA_DIR)) {
            fsSync.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`[${getDataHoraAtual()}] 📁 Diretório de dados criado em: ${DATA_DIR}`);
        }

        if (fsSync.existsSync(USER_DATA_FILE)) {
            const data = await fs.readFile(USER_DATA_FILE, 'utf-8');
            userDataStore = JSON.parse(data);
            console.log(`[${getDataHoraAtual()}] 💾 Dados de ${Object.keys(userDataStore).length} usuários carregados de ${USER_DATA_FILE}`);
        } else {
            console.log(`[${getDataHoraAtual()}] ℹ️ Arquivo ${USER_DATA_FILE} não encontrado. Iniciando com dados vazios.`);
            userDataStore = {};
        }
    } catch (error) {
        console.error(`[${getDataHoraAtual()}] ❌ Erro crítico ao carregar ${USER_DATA_FILE}:`, error);
        console.warn(`[${getDataHoraAtual()}] ⚠️ Iniciando com dados de usuário vazios devido a erro de carregamento.`);
        userDataStore = {}; // Reseta para evitar dados corrompidos
    }
};

/**
 * Salva o estado atual do userDataStore no arquivo JSON.
 * Função Debounced para evitar escritas excessivas.
 */
let saveTimeout;
const salvarDadosUsuarios = (delay = 1000) => { // Salva após 1 segundo de inatividade
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        try {
            await fs.writeFile(USER_DATA_FILE, JSON.stringify(userDataStore, null, 2)); // Pretty print JSON
            // console.log(`[${getDataHoraAtual()}] 💾 Dados de usuários salvos em ${USER_DATA_FILE}`);
        } catch (error) {
            console.error(`[${getDataHoraAtual()}] ❌ Erro ao salvar dados em ${USER_DATA_FILE}:`, error);
        }
    }, delay);
};

/**
 * Obtém os dados de um usuário específico, inicializando se for novo.
 * @param {string} userId ID do usuário (ex: 55119...).
 * @returns {object} Objeto com os dados do usuário.
 */
const getDadosUsuario = (userId) => {
    if (!userDataStore[userId]) {
        console.log(`[${getDataHoraAtual()}] ✨ Novo usuário detectado: ${userId}. Inicializando dados.`);
        userDataStore[userId] = {
            nome: null,
            estado: Estados.IDLE,
            mensagens: [],
            logs: [],
            ultimaInteracao: Date.now()
        };
        salvarDadosUsuarios(); // Salva imediatamente ao criar novo usuário
    }
    // Atualiza timestamp da última interação sempre que os dados são acessados
    userDataStore[userId].ultimaInteracao = Date.now();
    return userDataStore[userId];
};

/**
 * Atualiza os dados de um usuário específico.
 * @param {string} userId ID do usuário.
 * @param {object} novosDados Objeto com os campos a serem atualizados.
 */
const atualizarDadosUsuario = (userId, novosDados) => {
    if (!userDataStore[userId]) {
        console.warn(`[${getDataHoraAtual()}] ⚠️ Tentativa de atualizar dados de usuário inexistente: ${userId}`);
        getDadosUsuario(userId); // Cria se não existir
    }
    userDataStore[userId] = { ...userDataStore[userId], ...novosDados, ultimaInteracao: Date.now() };
    salvarDadosUsuarios(); // Agenda o salvamento
};

/**
 * Adiciona uma mensagem ao histórico do usuário, respeitando o limite.
 * @param {string} userId
 * @param {{role: string, content: string}} mensagem
 */
const adicionarMensagemHistorico = (userId, mensagem) => {
    const userData = getDadosUsuario(userId);
    userData.mensagens.push(mensagem);
    if (userData.mensagens.length > MAX_HISTORICO_MENSAGENS) {
        userData.mensagens = userData.mensagens.slice(-MAX_HISTORICO_MENSAGENS);
    }
    atualizarDadosUsuario(userId, { mensagens: userData.mensagens });
};

/**
 * Adiciona um log/flag para o usuário.
 * @param {string} userId
 * @param {string} log
 */
const adicionarLogUsuario = (userId, log) => {
    const userData = getDadosUsuario(userId);
    if (!userData.logs.includes(log)) {
        userData.logs.push(log);
        atualizarDadosUsuario(userId, { logs: userData.logs });
    }
};

// --- Funções Utilitárias Essenciais ---
const getDataHoraAtual = () => {
    return new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE });
};

const logConsole = (level, message, ...args) => {
    const timestamp = getDataHoraAtual();
    const levelMap = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", DEBUG: "🐞" };
    console.log(`[${timestamp}] ${levelMap[level] || "➡️"} ${message}`, ...args);
};

// --- Carregamento Seguro de Arquivos --- 
const carregarJsonSeguro = (filePath, defaultValue = {}) => {
    try {
        if (fsSync.existsSync(filePath)) {
            const data = fsSync.readFileSync(filePath, "utf-8");
            const jsonData = JSON.parse(data);
            logConsole("INFO", `Arquivo JSON carregado: ${path.basename(filePath)}`);
            return jsonData;
        } else {
            logConsole("WARN", `Arquivo JSON não encontrado: ${filePath}. Usando valor padrão.`);
            return defaultValue;
        }
    } catch (error) {
        logConsole("ERROR", `Erro ao carregar ou parsear JSON ${filePath}:`, error);
        return defaultValue;
    }
};

// --- Carregamento Inicial de Dados (JSONs) ---
const informativosPath = path.join(DATA_DIR, "informativos.json");
const informativos = carregarJsonSeguro(informativosPath, { conteudo_base: [] });

const regionalismosPath = path.join(DATA_DIR, "regionalismos.json");
const regionalismos = carregarJsonSeguro(regionalismosPath, {
    "oxente": "nossa", "visse": "entendeu", "arretado": "muito bom", "cabra": "pessoa",
    "uai": "ué", "sô": "moço", "trem": "coisa",
    "bah": "nossa", "guria": "menina", "guri": "menino", "tri": "legal",
    "égua": "nossa", "mana": "irmã ou amiga",
    "vc": "você", "blz": "beleza", "pq": "porque", "tmj": "estamos juntos", "vlw": "valeu", "obg": "obrigado"
});

const palavrasProibidasPath = path.join(DATA_DIR, "palavras_proibidas.json");
const palavrasProibidas = carregarJsonSeguro(palavrasProibidasPath, [
    "besta", "idiota", "burro", "corno", "otário", "vagabundo", "merda", "porra", "caralho",
    "cacete", "desgraça", "nojento", "imbecil", "babaca", "panaca", "arrombado", "fdp",
    "filho da puta", "escroto", "miserável", "cretino", "maldito", "diabo", "inferno",
    "vai se ferrar", "vai se foder", "foda-se", "puta", "piranha", "safado", "cu", "buceta",
    "boquete", "rola", "pau no cu", "tomar no cu", "cuzão", "chupa meu pau"
]);

// --- Outras Funções Utilitárias ---
const normalizarTextoRegional = (texto) => {
    if (!texto || typeof texto !== "string") return "";
    let textoNormalizado = texto;
    for (const [giria, neutro] of Object.entries(regionalismos)) {
        const regex = new RegExp(`\\b${giria.replace(/[-\\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi");
        textoNormalizado = textoNormalizado.replace(regex, neutro);
    }
    return textoNormalizado;
};

const identificarRegiao = (texto) => {
    if (!texto || typeof texto !== "string") return "Brasil";
    const textoLower = texto.toLowerCase();
    if (/\\b(oxente|visse|arretado|mainha|painho|mungunzá|macaxeira|jerimum)\\b/.test(textoLower)) return "Nordeste";
    if (/\\b(uai|sô|trem|pão de queijo|quitanda)\\b/.test(textoLower)) return "Minas Gerais";
    if (/\\b(bah|guria|guri|tri|chimarrão|bergamota|capaz)\\b/.test(textoLower)) return "Sul";
    if (/\\b(égua|maninho|tacacá|açaí|pai d'égua)\\b/.test(textoLower)) return "Norte";
    return "Brasil";
};

const removerAcentosEPontuacao = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,!?;:()]/g, "");
};

/**
 * Consulta preços de produtos na API do Economiza Alagoas
 * Filtra apenas pelo Popular Supermercado e últimos 3 dias
 * @param {string} nomeProduto Nome do produto para pesquisar
 * @returns {Promise<object>} Resultado da consulta de preços
 */
const consultarPrecoEconomizaAlagoas = async (nomeProduto) => {
    try {
        const requestBody = {
            produto: {
                descricao: nomeProduto.toUpperCase()
            },
            estabelecimento: {
                individual: {
                    cnpj: POPULAR_SUPERMERCADO_CNPJ // Filtra apenas pelo Popular Supermercado
                }
            },
            dias: 3, // Últimos 3 dias conforme solicitado
            pagina: 1,
            registrosPorPagina: 50 // Mínimo permitido pela API
        };

        const response = await axios.post(ECONOMIZA_ALAGOAS_API_URL, requestBody, {
            headers: {
                'AppToken': ECONOMIZA_ALAGOAS_TOKEN,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    } catch (error) {
        logConsole('ERROR', `Erro ao consultar API Economiza Alagoas para produto "${nomeProduto}":`, error.message);
        throw error;
    }
};

/**
 * Formata a resposta da consulta de preços para envio ao usuário
 * Foca apenas no Popular Supermercado e inclui marca/descrição detalhada
 * @param {object} dadosAPI Dados retornados pela API do Economiza Alagoas
 * @param {string} nomeProduto Nome do produto pesquisado
 * @param {string} nomeCliente Nome do cliente
 * @returns {string} Mensagem formatada para o usuário
 */
const formatarRespostaPrecos = (dadosAPI, nomeProduto, nomeCliente) => {
    if (!dadosAPI || !dadosAPI.conteudo || dadosAPI.conteudo.length === 0) {
        return `Opa, ${nomeCliente}! 😔 Não encontrei "${nomeProduto}" no Popular Supermercado nos últimos 3 dias. Pode ser que o produto não tenha sido vendido recentemente ou tenha outro nome. Tente pesquisar com uma descrição mais específica (ex: "arroz pilão 1kg")!`;
    }

    const totalRegistros = dadosAPI.totalRegistros || 0;
    const produtos = dadosAPI.conteudo.slice(0, 10); // Mostra mais produtos já que é só um supermercado

    let resposta = `🛒 **Popular Supermercado** - Encontrei ${totalRegistros} resultado(s) para "${nomeProduto}" nos últimos 3 dias:\n\n`;

    produtos.forEach((item, index) => {
        const produto = item.produto;
        const venda = produto.venda;
        
        // Extrai marca/descrição mais detalhada
        const descricaoCompleta = produto.descricao || 'Produto';
        const descricaoSefaz = produto.descricaoSefaz || '';
        
        // Usa a descrição da Sefaz se disponível (geralmente mais padronizada)
        const descricaoFinal = descricaoSefaz && descricaoSefaz.trim() !== '' ? descricaoSefaz : descricaoCompleta;
        
        const preco = venda.valorVenda ? `R$ ${venda.valorVenda.toFixed(2).replace('.', ',')}` : 'Preço não informado';
        const dataVenda = venda.dataVenda ? new Date(venda.dataVenda).toLocaleDateString('pt-BR') : 'Data não informada';
        
        resposta += `${index + 1}. 📦 **${descricaoFinal}**\n`;
        resposta += `   💰 ${preco}`;
        if (produto.unidadeMedida) {
            resposta += ` por ${produto.unidadeMedida}`;
        }
        if (produto.gtin && produto.gtin !== '0') {
            resposta += ` (Cód: ${produto.gtin})`;
        }
        resposta += `\n   📅 Preço atualizado em: ${dataVenda}\n\n`;
    });

    if (totalRegistros > 10) {
        resposta += `📊 Mostrando os 10 primeiros de ${totalRegistros} resultados encontrados.\n\n`;
    }

    resposta += `🏪 **Popular Supermercado** - Arapiraca/AL\n`;
    resposta += `💡 *Preços baseados em vendas reais dos últimos 3 dias. Os valores podem variar.*\n\n`;
    resposta += `Precisa de mais alguma coisa, ${nomeCliente}? 😊`;

    return resposta;
};

/**
 * Trata mensagens de áudio, baixando-as e transcrevendo-as.
 * @param {object} message Objeto da mensagem do WPPConnect.
 * @param {object} client Instância do cliente WPPConnect.
 */
const tratarMensagemDeAudio = async (message, client) => {
    const userId = message.from;
    const userData = getDadosUsuario(userId);
    logConsole("INFO", `Recebido áudio de ${userId}. Baixando...`);

    let caminhoAudio = null;
    try {
        await client.startTyping(userId);
        const buffer = await client.decryptFile(message);
        const nomeArquivo = `${message.id}.ogg`; // WPPConnect geralmente retorna OGG
        caminhoAudio = path.join(TEMP_DIR, nomeArquivo);
        await fs.writeFile(caminhoAudio, buffer);
        logConsole("INFO", `Áudio de ${userId} salvo em: ${caminhoAudio}`);

        await client.sendText(userId, `Obrigado pelo áudio, ${userData.nome || 'cliente'}! Estou transcrevendo... 🎧`);

        let transcricao = "";
        // Tenta transcrever com Whisper local primeiro, se falhar, tenta AssemblyAI
        try {
            transcricao = await transcreverComWhisperLocal(caminhoAudio);
            logConsole("INFO", `Transcrição local (Whisper) de ${userId} concluída.`);
        } catch (whisperError) {
            logConsole("WARN", `Falha na transcrição local (Whisper) para ${userId}: ${whisperError.message}. Tentando AssemblyAI...`);
            try {
                transcricao = await transcreverComAssemblyAI(caminhoAudio);
                logConsole("INFO", `Transcrição via AssemblyAI de ${userId} concluída.`);
            } catch (assemblyError) {
                logConsole("ERROR", `Falha na transcrição via AssemblyAI para ${userId}: ${assemblyError.message}`);
                throw new Error("Ambos os serviços de transcrição falharam");
            }
        }

        if (transcricao && transcricao.trim().length > 0) {
            logConsole("INFO", `Transcrição de ${userId}: "${transcricao}"`);
            await client.sendText(userId, `🎤 Sua mensagem de áudio: "${transcricao}"`);
            
            // Cria uma nova mensagem simulada com a transcrição para processar como texto
            const mensagemTexto = {
                ...message,
                body: transcricao,
                type: 'chat'
            };
            
            // Processa a transcrição como uma mensagem de texto normal
            await tratarMensagemTexto(mensagemTexto, client);
        } else {
            await client.sendText(userId, `Desculpe, ${userData.nome || 'cliente'}, não consegui transcrever seu áudio. 😔 Poderia tentar novamente ou digitar sua mensagem?`);
        }
    } catch (error) {
        logConsole("ERROR", `Erro ao processar áudio de ${userId}:`, error);
        await client.sendText(userId, `Ops! Houve um erro ao processar seu áudio, ${userData.nome || 'cliente'}. Por favor, tente novamente mais tarde ou digite sua mensagem.`);
    } finally {
        // Limpa o arquivo de áudio temporário
        if (caminhoAudio && fsSync.existsSync(caminhoAudio)) {
            try {
                await fs.unlink(caminhoAudio);
                logConsole("INFO", `Arquivo temporário de áudio removido: ${caminhoAudio}`);
            } catch (unlinkError) {
                logConsole("WARN", `Erro ao remover arquivo temporário ${caminhoAudio}:`, unlinkError);
            }
        }
        await client.stopTyping(userId);
    }
};

/**
 * Trata mensagens de texto (incluindo transcrições de áudio).
 * @param {object} message Objeto da mensagem do WPPConnect.
 * @param {object} client Instância do cliente WPPConnect.
 */
const tratarMensagemTexto = async (message, client) => {
    const userId = message.from;
    const textoOriginal = message.body || '';
    const textoLower = textoOriginal.toLowerCase();
    const userData = getDadosUsuario(userId);

    logConsole('DEBUG', `Mensagem recebida de ${userId} (Nome: ${userData.nome || 'N/A'}, Estado: ${userData.estado}): "${textoOriginal}"`);

    try {
        await client.sendSeen(userId);

        // --- Lógica baseada em ESTADO --- 

        // Estado: Aguardando Confirmação para Atendimento Humano
        if (userData.estado === Estados.AWAITING_HUMAN_CONFIRMATION) {
            if (/\bsim\b|\bquero\b|\bconfirm(o|ar)\b|\bpode\b/i.test(textoLower)) {
                logConsole('INFO', `Usuário ${userId} confirmou pedido de atendimento humano.`);
                atualizarDadosUsuario(userId, { estado: Estados.HUMAN_REQUESTED });
                await client.sendText(userId, `Ok, ${userData.nome || 'cliente'}! 👍 Já solicitei um atendente humano para você. Por favor, aguarde um momento que logo alguém entrará em contato. Enquanto isso, não consigo processar outras solicitações.`);
                
                // Notificação para atendente
                if (NUMERO_ATENDENTE) {
                    try {
                        const nomeCliente = userData.nome || 'Não informado';
                        const msgNotificacao = `🔔 *Solicitação de Atendimento Humano* 🔔\n\nCliente: ${nomeCliente} (${userId})\nSolicitou atendimento humano agora.\n\nLink direto: wa.me/${userId.split('@')[0]}`;
                        await client.sendText(NUMERO_ATENDENTE, msgNotificacao);
                        logConsole('INFO', `Notificação de atendimento enviada para ${NUMERO_ATENDENTE}`);
                    } catch (errNotify) {
                        logConsole('ERROR', `Falha ao notificar atendente ${NUMERO_ATENDENTE} sobre ${userId}`, errNotify);
                    }
                } else {
                    logConsole('WARN', `Usuário ${userId} pediu atendente, mas NUMERO_ATENDENTE não está configurado.`);
                }
                return;

            } else if (/\bn(ã|a)o\b|\bcancelar\b|\bdeixa\b/i.test(textoLower)) {
                logConsole('INFO', `Usuário ${userId} cancelou pedido de atendimento humano.`);
                atualizarDadosUsuario(userId, { estado: Estados.IDLE });
                await client.sendText(userId, `Entendido, ${userData.nome || 'cliente'}! 😊 Cancelamos a solicitação. Se precisar de algo mais, é só chamar!`);
                return;
            } else {
                await client.sendText(userId, `Desculpe, ${userData.nome || 'cliente'}, não entendi. Você quer que eu chame um atendente humano? Por favor, responda com "Sim" ou "Não".`);
                return;
            }
        }

        // Estado: Atendimento Humano Solicitado (Bot não interage mais ativamente)
        if (userData.estado === Estados.HUMAN_REQUESTED) {
            logConsole('INFO', `Mensagem recebida de ${userId} enquanto aguarda atendente. Bot não responderá.`);
            return;
        }

        // --- Fluxo Normal (Estado IDLE ou outros) --- 

        // 1. Detecção de Pedido de Atendimento Humano
        const pediuAtendente = /\b(atendente|humano|pessoa|falar com alguem|algu(e|é)m|suporte|ajuda real)\b/i.test(textoLower);
        if (pediuAtendente && !textoLower.includes('não quero falar com atendente')) {
            logConsole('INFO', `Usuário ${userId} parece estar pedindo atendimento humano.`);
            atualizarDadosUsuario(userId, { estado: Estados.AWAITING_HUMAN_CONFIRMATION });
            await client.sendText(userId, `Percebi que você talvez queira falar com um de nossos atendentes humanos, ${userData.nome || 'cliente'}. É isso mesmo? 😊 Responda "Sim" para confirmar ou "Não" para continuar comigo.`);
            return;
        }

        // 2. Captura de Nome
        const nomeMatch = textoOriginal.match(/(?:meu\s+)?nome\s+(?:é|eh|seja)\s+(\w+)/i);
        if (userData.estado === Estados.IDLE && !userData.nome && nomeMatch && nomeMatch[1]) {
            const nomeCapturado = nomeMatch[1].charAt(0).toUpperCase() + nomeMatch[1].slice(1);
            atualizarDadosUsuario(userId, { nome: nomeCapturado, estado: Estados.IDLE });
            logConsole('INFO', `Nome de ${userId} definido como: ${nomeCapturado}`);
            await client.sendText(userId, `Prazer em conhecer, ${nomeCapturado}! 😊 Como posso te ajudar hoje?`);
            adicionarMensagemHistorico(userId, { role: 'user', content: textoOriginal });
            adicionarMensagemHistorico(userId, { role: 'assistant', content: `Prazer em conhecer, ${nomeCapturado}! 😊 Como posso te ajudar hoje?` });
            return;
        }

        // Se o bot não sabe o nome e o usuário manda a primeira msg
        if (userData.estado === Estados.IDLE && !userData.nome && userData.mensagens.length === 0) {
            logConsole('INFO', `Primeira interação de ${userId} sem nome. Solicitando nome.`);
            atualizarDadosUsuario(userId, { estado: Estados.AWAITING_NAME });
            await client.sendText(userId, 'Olá! 👋 Sou o Atendente POP, seu assistente virtual. Para começar, pode me dizer seu nome, por favor?');
            adicionarMensagemHistorico(userId, { role: 'user', content: textoOriginal });
            adicionarMensagemHistorico(userId, { role: 'assistant', content: 'Olá! 👋 Sou o Atendente POP, seu assistente virtual. Para começar, pode me dizer seu nome, por favor?' });
            return;
        }

        // Se estava aguardando nome e recebeu algo
        if (userData.estado === Estados.AWAITING_NAME) {
            const nomeCapturado = textoOriginal.trim().split(' ')[0];
            if (nomeCapturado.length > 2 && nomeCapturado.length < 20) {
                const nomeFormatado = nomeCapturado.charAt(0).toUpperCase() + nomeCapturado.slice(1);
                atualizarDadosUsuario(userId, { nome: nomeFormatado, estado: Estados.IDLE });
                logConsole('INFO', `Nome de ${userId} definido como: ${nomeFormatado} (estado AWAITING_NAME)`);
                await client.sendText(userId, `Legal, ${nomeFormatado}! 😊 Agora sim. Em que posso te ajudar?`);
                adicionarMensagemHistorico(userId, { role: 'user', content: textoOriginal });
                adicionarMensagemHistorico(userId, { role: 'assistant', content: `Legal, ${nomeFormatado}! 😊 Agora sim. Em que posso te ajudar?` });
            } else {
                await client.sendText(userId, 'Hum... não entendi muito bem. 🤔 Poderia repetir seu nome, por favor?');
                adicionarMensagemHistorico(userId, { role: 'user', content: textoOriginal });
                adicionarMensagemHistorico(userId, { role: 'assistant', content: 'Hum... não entendi muito bem. 🤔 Poderia repetir seu nome, por favor?' });
            }
            return;
        }

        // 3. Verificação de Palavrões
        const textoSemAcentos = removerAcentosEPontuacao(textoLower);
        const palavraoEncontrado = palavrasProibidas.find((p) => {
            const regex = new RegExp(`\\b${p}\\b`, 'i');
            return regex.test(textoSemAcentos);
        });
        if (palavraoEncontrado) {
            logConsole('WARN', `Palavra proibida detectada de ${userId}: "${palavraoEncontrado}"`);
            const respostasEducadas = [
                '🙏 Opa! Vamos manter nossa conversa respeitosa, que tal? Estou aqui pra te ajudar da melhor maneira possível. 😊',
                'Vamos manter o nível da conversa? Respeito é bom e todo mundo gosta! 🤗',
                'Por favor, evite usar esse tipo de linguagem. Podemos conversar de forma mais amigável? 🙏',
                '⚠️ Gentileza gera gentileza! Peço que use um tom mais respeitoso para que eu possa te ajudar melhor, combinado?',
            ];
            const respostaEscolhida = respostasEducadas[Math.floor(Math.random() * respostasEducadas.length)];
            await client.sendText(userId, respostaEscolhida);
            salvarDadosUsuarios();
            return;
        }

        // Adiciona mensagem do usuário ao histórico ANTES de processar oferta ou IA
        adicionarMensagemHistorico(userId, { role: 'user', content: textoOriginal });

        // Emite evento para o painel (se conectado)
        if (typeof socket !== 'undefined') {
            socket.emit("nova_mensagem", {
                conversa_id: null,
                mensagem: {
                    cliente_id: userId,
                    conteudo: textoOriginal,
                    data_envio: new Date().toISOString()
                }
            });
        }

        // 4. T        // 4. Tratamento de Pedido de Ofertas do Dia (Lógica movida para após a IA)estado: Estados.IDLE });
            }
            return;
        }

        // 5. Interação com IA (se não for nenhuma das anteriores e estado for IDLE)
        if (userData.estado === Estados.IDLE) {
            atualizarDadosUsuario(userId, { estado: Estados.PROCESSING_QUERY });
            await client.startTyping(userId);
            let digitando = true;
            logConsole('INFO', `Enviando mensagem de ${userId} para IA...`);

            const nomeCliente = userData.nome || 'cliente';
            const regiao = identificarRegiao(textoOriginal);
            const textoNormalizado = normalizarTextoRegional(textoLower);

            const promptSystem = [
                `Você é o Atendente POP, um assistente virtual de WhatsApp para nossa loja. Seja extremamente simpático, prestativo, use linguagem informal brasileira e emojis 😊🎉🛒.`, 
                `O nome do cliente é ${nomeCliente}. Use o nome dele(a) sempre que possível (Ex: "Oi ${nomeCliente}!", "Claro, ${nomeCliente}!"). Se o nome for "cliente", *não* pergunte o nome aqui, o sistema já tratou disso.`,
                `A região provável do cliente é ${regiao}. Se apropriado e natural, use uma expressão regional como "oxente", "uai", "bah", "égua", mas com moderação.`, 
                `--- BASE DE CONHECIMENTO (Responda SOMENTE com base nisso) ---`, 
                ...(informativos.conteudo_base || []).map(item => `- ${item}`),
                `--------------------------------------------------------------`, 
                `REGRAS IMPORTANTES:`, 
                `1. FOCO NO CLIENTE: Seja acolhedor e paciente.`, 
                `2. BASE DE CONHECIMENTO É TUDO: *NÃO invente* informações. Se a resposta não estiver na base, diga algo como: "Puxa, ${nomeCliente}, sobre isso eu não tenho a informação aqui comigo. 🤔 Você pode verificar diretamente na loja ou com um de nossos atendentes humanos?".`, 
                `3. OFERTAS: Se perguntarem sobre "ofertas/promoções/descontos", tente identificar o dia da semana mencionado (ex: "ofertas de segunda", "promoções para o fim de semana"). Se identificar um dia, responda *APENAS* com o formato `[OFERTA_DIA: <Dia da Semana>]` (ex: `[OFERTA_DIA: Segunda-feira]`, `[OFERTA_DIA: Sábado]`). Se não identificar um dia específico, mas for um pedido geral de ofertas, responda *APENAS*: "Estou buscando as ofertas do dia pra você, ${nomeCliente}! Só um instante! 🛍️". O sistema enviará as imagens. Não detalhe as ofertas aqui.`, 
                `4. CONSULTA DE PREÇOS: Se perguntarem sobre preço de algum produto específico (ex: "quanto custa leite", "preço do arroz", "valor da coca-cola"), responda *APENAS* com o formato `[CONSULTAR_PRECO: <nome do produto>]` (ex: `[CONSULTAR_PRECO: leite]`, `[CONSULTAR_PRECO: arroz]`). O sistema buscará os preços atuais em Arapiraca. Não invente preços.`,
                `5. ATENDENTE HUMANO: Se o cliente pedir para falar com um atendente/humano/pessoa/suporte, *NÃO responda diretamente*. O sistema cuidará disso. Apenas continue a conversa normalmente se for outro assunto.`,
                `6. EVITE REPETIÇÃO: Se precisar repetir uma informação, tente usar palavras diferentes.`, 
                `7. SEJA CONCISO: Respostas claras e diretas são melhores no WhatsApp.`, 
                `8. TOM DE VOZ: Mantenha o tom amigável e prestativo SEMPRE.`
            ].join('\n');

            const mensagensIA = [
                { role: 'system', content: promptSystem },
                ...userData.mensagens.filter(m => m.role === 'user' || m.role === 'assistant')
            ];

            const ultimaRespostaAssistant = userData.mensagens.filter(h => h.role === 'assistant').slice(-1)[0]?.content || '';

            try {
                const respostaIA = await axios.post(
                    'https://openrouter.ai/api/v1/chat/completions',
                    {
                        model: IA_MODEL,
                        messages: mensagensIA,
                        temperature: 0.7,
                        max_tokens: 150
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                            'Content-Type': 'application/json',
                            'HTTP-Referer': 'http://localhost', 
                            'X-Title': 'WPP-Atendente-POP'
                        },
                        timeout: 20000
                    }
                );

                let textoIAResposta = respostaIA.data.choices?.[0]?.message?.content?.trim();

                if (!textoIAResposta) {
                    throw new Error('Resposta da IA vazia ou inválida.');
                }

                if (textoIAResposta === ultimaRespostaAssistant) {
                    const alternativas = [
                        `Como eu disse antes, ${nomeCliente}: ${textoIAResposta}`, 
                        `Reforçando o que te falei, ${nomeCliente}: ${textoIAResposta}`, 
                        `Só pra confirmar, ${nomeCliente}: ${textoIAResposta}`
                    ];
                    textoIAResposta = alternativas[Math.floor(Math.random() * alternativas.length)];
                }

                // --- Nova lógica para identificar pedido de oferta com dia específico da IA ---
                const ofertaDiaMatch = textoIAResposta.match(/\[OFERTA_DIA:\s*(.*?)\]/i);
                if (ofertaDiaMatch && ofertaDiaMatch[1]) {
                    const diaDaSemanaIA = ofertaDiaMatch[1].trim();
                    logConsole("INFO", `IA identificou pedido de oferta para o dia: ${diaDaSemanaIA}`);
                    atualizarDadosUsuario(userId, { estado: Estados.PROCESSING_OFFER });
                    await client.sendText(userId, `Entendido, ${userData.nome || 'cliente'}! Vou buscar as ofertas para ${diaDaSemanaIA} pra você! 🛍️`);
                    await client.startTyping(userId);

                    try {
                        const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
                        const nomeDiaNormalizado = diasSemana.find(d => d.toLowerCase() === diaDaSemanaIA.toLowerCase());

                        if (!nomeDiaNormalizado) {
                            await client.sendText(userId, `Desculpe, ${userData.nome || 'cliente'}, não consegui identificar um dia válido para as ofertas. Poderia especificar melhor?`);
                            return;
                        }

                        const pastaDoDia = path.join(OFERTAS_DIR, nomeDiaNormalizado);
                        const tagOfertaDia = `oferta-${nomeDiaNormalizado}-${new Date().toLocaleDateString('pt-BR')}`; // Tag para evitar reenvio no mesmo dia

                        if (userData.logs.includes(tagOfertaDia)) {
                            await client.sendText(userId, `😉 ${userData.nome || 'Cliente'}, já te mandei as ofertas de ${nomeDiaNormalizado} mais cedo! Se precisar ver de novo, é só pedir de outra forma ou falar com um atendente.`);
                            atualizarDadosUsuario(userId, { estado: Estados.IDLE });
                            return;
                        }

                        if (!fsSync.existsSync(OFERTAS_DIR)) fsSync.mkdirSync(OFERTAS_DIR, { recursive: true });
                        if (!fsSync.existsSync(pastaDoDia)) fsSync.mkdirSync(pastaDoDia, { recursive: true });

                        const arquivos = await fs.readdir(pastaDoDia);
                        const imagensOferta = arquivos.filter(arquivo => /\.(jpg|jpeg|png|webp)$/i.test(arquivo));
                        logConsole('DEBUG', `Arquivos encontrados na pasta ${pastaDoDia}:`, arquivos);
                        logConsole('DEBUG', `Imagens filtradas para envio:`, imagensOferta);

                        if (imagensOferta.length > 0) {
                            logConsole('INFO', `Imagens encontradas para ${nomeDiaNormalizado} (${userId}): ${imagensOferta.join(', ')}`);
                            await client.sendText(userId, `Aqui estão as ofertas especiais de ${nomeDiaNormalizado}! 🎉 Dá uma olhada:`);
                            let imagensEnviadas = 0;
                            
                            for (const nomeArquivo of imagensOferta) {
                                const caminhoImagem = path.join(pastaDoDia, nomeArquivo);
                                try {
                                    await fs.access(caminhoImagem);
                                    const legenda = nomeArquivo.split(".")[0].replace(/[_-]/g, " ");
                                    await client.sendFile(userId, caminhoImagem, nomeArquivo, `✨ ${legenda.charAt(0).toUpperCase() + legenda.slice(1)} ✨`);
                                    logConsole("INFO", `Imagem enviada com sucesso para ${userId}: ${nomeArquivo}`);
                                    imagensEnviadas++;
                                    await new Promise(resolve => setTimeout(resolve, PAUSA_ENTRE_IMAGENS_MS));
                                } catch (errImg) {
                                    logConsole("ERROR", `Erro ao enviar a imagem ${nomeArquivo} para ${userId}:`, errImg.message || errImg);
                                    await client.sendText(userId, `😥 Ops! Não consegui enviar a imagem "${nomeArquivo}". Vou tentar as próximas.`);
                                }
                            }

                            if (imagensEnviadas > 0) {
                                adicionarLogUsuario(userId, tagOfertaDia);
                                await client.sendText(userId, `Pronto! 🎉 Enviei ${imagensEnviadas} ofertas especiais para você. Se tiver alguma dúvida ou quiser mais informações sobre algum produto, é só perguntar!`);
                            } else {
                                await client.sendText(userId, `😔 Desculpe, ${userData.nome || 'cliente'}, não consegui enviar as ofertas agora. Tente novamente mais tarde ou fale com um atendente.`);
                            }
                        } else {
                            await client.sendText(userId, `Opa, ${userData.nome || 'cliente'}! Não temos ofertas especiais para ${nomeDiaNormalizado} no momento. 😔 Mas fique de olho que sempre temos novidades! Posso te ajudar com algo mais?`);
                        }
                    } catch (errorOferta) {
                        logConsole('ERROR', `Erro ao processar ofertas para ${userId}:`, errorOferta);
                        await client.sendText(userId, `Ops! Houve um problema ao buscar as ofertas, ${userData.nome || 'cliente'}. 😔 Tente novamente mais tarde ou fale com um atendente.`);
                    } finally {
                        await client.stopTyping(userId);
                        atualizarDadosUsuario(userId, { estado: Estados.IDLE });
                    }
                    return; // Finaliza o processamento se a IA indicou um dia de oferta
                }
                // --- Fim da nova lógica ---

                // --- Nova lógica para identificar consulta de preços da IA ---
                const consultaPrecoMatch = textoIAResposta.match(/\[CONSULTAR_PRECO:\s*(.*?)\]/i);
                if (consultaPrecoMatch && consultaPrecoMatch[1]) {
                    const nomeProduto = consultaPrecoMatch[1].trim();
                    logConsole("INFO", `IA identificou consulta de preço para o produto: ${nomeProduto}`);
                    atualizarDadosUsuario(userId, { estado: Estados.PROCESSING_PRICE });
                    await client.sendText(userId, `Perfeito, ${userData.nome || 'cliente'}! Vou consultar os preços de "${nomeProduto}" em Arapiraca pra você! 💰 Só um minutinho...`);
                    await client.startTyping(userId);

                    try {
                        const dadosPrecos = await consultarPrecoEconomizaAlagoas(nomeProduto);
                        const respostaFormatada = formatarRespostaPrecos(dadosPrecos, nomeProduto, userData.nome || 'cliente');
                        
                        await client.sendText(userId, respostaFormatada);
                        logConsole("INFO", `Consulta de preços enviada com sucesso para ${userId}: ${nomeProduto}`);
                        
                        // Adiciona ao histórico para a IA saber que foi processado
                        adicionarMensagemHistorico(userId, { role: 'assistant', content: respostaFormatada });
                        
                    } catch (errorPreco) {
                        logConsole('ERROR', `Erro ao consultar preços para ${userId}:`, errorPreco);
                        let msgErro;
                        
                        if (errorPreco.code === 'ECONNABORTED' || errorPreco.message.includes('timeout')) {
                            msgErro = `Ops! A consulta de preços está demorando mais que o esperado, ${userData.nome || 'cliente'}. 😔 O sistema pode estar sobrecarregado. Tente novamente em alguns minutos.`;
                        } else if (errorPreco.response?.status === 500) {
                            msgErro = `Desculpe, ${userData.nome || 'cliente'}! O sistema de consulta de preços está temporariamente indisponível. 😔 Tente novamente mais tarde ou fale com um atendente.`;
                        } else if (errorPreco.response?.status === 400) {
                            msgErro = `Hmm, ${userData.nome || 'cliente'}! Não consegui processar a consulta para "${nomeProduto}". 🤔 Tente ser mais específico na descrição (ex: "arroz pilão 1kg") ou fale com um atendente.`;
                        } else {
                            msgErro = `Ops! Houve um problema ao consultar os preços de "${nomeProduto}" no Popular Supermercado, ${userData.nome || 'cliente'}. 😔 Tente novamente mais tarde ou fale com um atendente.`;
                        }
                        
                        await client.sendText(userId, msgErro);
                        adicionarMensagemHistorico(userId, { role: 'assistant', content: msgErro });
                    } finally {
                        await client.stopTyping(userId);
                        atualizarDadosUsuario(userId, { estado: Estados.IDLE });
                    }
                    return; // Finaliza o processamento se a IA indicou consulta de preço
                }
                // --- Fim da lógica de consulta de preços ---

                adicionarMensagemHistorico(userId, { role: 'assistant', content: textoIAResposta });
                await client.sendText(userId, textoIAResposta);
                logConsole('INFO', `Resposta da IA enviada com sucesso para ${userId}.`);

            } catch (errIA) {
                logConsole('ERROR', `Erro ao chamar a API da IA para ${userId}:`, errIA.response?.data || errIA.message);
                const fallbackMsg = `Desculpe, ${nomeCliente}, estou com um probleminha técnico para processar sua pergunta agora. 🤯 Por favor, tente novamente em alguns instantes ou, se preferir, peça para falar com um atendente humano.`;
                adicionarMensagemHistorico(userId, { role: 'assistant', content: fallbackMsg });
                await client.sendText(userId, fallbackMsg);
            } finally {
                if (digitando) await client.stopTyping(userId);
                atualizarDadosUsuario(userId, { estado: Estados.IDLE });
            }
        } else {
            logConsole('WARN', `Mensagem de ${userId} recebida em estado inesperado (${userData.estado}). Resetando para IDLE.`);
            atualizarDadosUsuario(userId, { estado: Estados.IDLE });
        }

    } catch (errorGeral) {
        logConsole('ERROR', `Erro GERAL ao processar mensagem de ${userId}:`, errorGeral);
        atualizarDadosUsuario(userId, { estado: Estados.IDLE });
        try {
            await client.sendText(userId, 'Ops! 🤯 Ocorreu um erro inesperado aqui do meu lado. Já estamos verificando. Por favor, tente novamente mais tarde.');
        } catch (errSend) {
            logConsole('ERROR', `Falha ao enviar mensagem de erro GERAL para ${userId}:`, errSend);
        }
    }
};

// --- Função Principal de Inicialização --- 
async function start() {
    // Carrega dados persistentes ANTES de iniciar o cliente
    await carregarDadosUsuarios();

    let clientInstance = null; // Variável para guardar a instância do cliente
    let socket = null; // Variável para guardar a instância do socket

    wppconnect
        .create({
            session: SESSION_NAME,
            headless: false,
            devtools: false,
            useChrome: true,
            debug: false,
            logQR: true,
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
                logConsole('INFO', `Tentativa ${attempts} de gerar QR Code. Escaneie com o celular!`);
            },
            statusFind: (statusSession, session) => {
                logConsole('INFO', `Status da sessão (${session}): ${statusSession}`);
                if (['notLogged', 'browserClose', 'qrReadFail', 'serverClose', 'deviceNotConnected'].includes(statusSession)) {
                    logConsole('ERROR', `Problema crítico na sessão ${session}: ${statusSession}. O bot pode parar de funcionar.`);
                }
            },
        })
        .then((client) => {
            clientInstance = client; // Guarda a instância do cliente
            logConsole('INFO', `Atendente POP conectado com sucesso na sessão: ${SESSION_NAME}!`);
            
            // === Integração com Painel ===
            try {
                socket = io("http://localhost:5000", {
                    query: {
                        token: "painel-bot-token"
                    }
                });

                socket.on("connect", () => {
                    console.log("✅ Bot conectado ao painel via WebSocket");
                });

                socket.on("disconnect", () => {
                    console.log("❌ Bot desconectado do painel");
                });

                // Recebe mensagens do painel para enviar ao cliente
                socket.on("mensagem_para_cliente", async ({ cliente_id, conteudo }) => {
                    if (cliente_id.endsWith('@g.us')) {
                        console.log(`❌ Mensagem bloqueada: tentativa de envio para grupo (${cliente_id}) ignorada.`);
                        return;
                    }

                    console.log(`📩 Mensagem recebida do painel: "${conteudo}" para ${cliente_id}`);
                    await client.sendText(cliente_id, conteudo);
                });
            } catch (socketError) {
                logConsole('WARN', 'Erro ao conectar com o painel via WebSocket:', socketError);
            }

            // --- Bloqueio de Funções de Status --- 
            const bloquearFuncoesStatus = () => {
                const funcoesParaBloquear = [
                    'sendTextStatus', 'sendImageStatus', 'sendVideoStatus', 'sendAudioStatus',
                    'sendLinkStatus', 'sendLocationStatus', 'sendVCardStatus', 'sendStickerStatus',
                    'sendImageAsStickerStatus'
                ];
                let countBloqueadas = 0;
                funcoesParaBloquear.forEach(funcName => {
                    if (typeof client[funcName] === 'function') {
                        client[funcName] = async (...args) => {
                            const userAttempting = args[0];
                            logConsole('WARN', `Bloqueado: Tentativa de chamar ${funcName} pelo usuário ${userAttempting || 'desconhecido'}.`);
                            return Promise.resolve({ id: null, ack: -1, status: 'blocked', reason: 'Status posting is disabled.' });
                        };
                        countBloqueadas++;
                    }
                });
                logConsole('INFO', `Bloqueio de status aplicado. ${countBloqueadas} funções sobrescritas.`);
            };
            bloquearFuncoesStatus();

            // --- Tratamento Principal de Mensagens --- 
            client.onMessage(async (message) => {
                // Verifica se é áudio
                if (message.type === 'audio' || message.type === 'ptt') {
                    await tratarMensagemDeAudio(message, client);
                    return;
                }
                
                // Filtros básicos
                if (!message || message.isGroupMsg || message.fromMe || !message.from || !message.from.endsWith('@c.us') || message.type === 'revoked') {
                    return;
                }

                // Processa mensagem de texto
                await tratarMensagemTexto(message, client);
            });

            // --- Tratamento de Desconexão/Erros do Cliente --- 
            client.onStateChange((state) => {
                logConsole('WARN', `Mudança de estado da sessão ${SESSION_NAME}: ${state}`);
                if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
                    logConsole('ERROR', `Estado crítico ${state} detectado! O bot pode precisar ser reiniciado ou o QR Code escaneado novamente.`);
                }
            });

        })
        .catch((error) => {
            logConsole('ERROR', `ERRO FATAL ao iniciar WPPConnect (${SESSION_NAME}):`, error);
            process.exit(1);
        });

    // --- Tratamento de Encerramento do Processo --- 
    const gracefulShutdown = async () => {
        logConsole('INFO', 'Recebido sinal de encerramento. Fechando conexão WPPConnect...');
        if (clientInstance) {
            try {
                await clientInstance.close();
                logConsole('INFO', 'Cliente WPPConnect fechado com sucesso.');
            } catch (err) {
                logConsole('ERROR', 'Erro ao fechar cliente WPPConnect:', err);
            }
        }

        // Garante que os dados pendentes sejam salvos
        clearTimeout(saveTimeout);
        try {
            if (Object.keys(userDataStore).length > 0) {
                fsSync.writeFileSync(USER_DATA_FILE, JSON.stringify(userDataStore, null, 2));
                logConsole('INFO', `Dados finais de usuários salvos em ${USER_DATA_FILE}`);
            }
        } catch (error) {
            logConsole('ERROR', `Erro ao salvar dados finais em ${USER_DATA_FILE}:`, error);
        }
        process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown); // Ctrl+C
    process.on('SIGTERM', gracefulShutdown); // Sinal de término
}

// Inicia a aplicação
start();

