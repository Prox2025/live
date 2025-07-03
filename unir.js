const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const arquivosTemporarios = [];

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`🗑️ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao remover ${arquivo}:`, e.message);
    }
  }
}

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) {
        console.log(`✅ FFmpeg finalizado com sucesso.`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function autenticar() {
  console.log('🔐 Autenticando no Google Drive...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  console.log('🔓 Autenticação concluída com sucesso.');
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  console.log(`📥 Baixando do Drive\nID: ${fileId}\n→ ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`✅ Download finalizado: ${destino}`);
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', err => reject(err));
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) {
        resolve(parseFloat(output.trim()));
      } else {
        reject(new Error('❌ ffprobe falhou'));
      }
    });
  });
}

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input} em dois...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function reencode(input, output) {
  console.log(`🔄 Reencodando ${input} para ${output}...`);
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function gerarImagemTexto(texto, output) {
  console.log(`🖊️ Gerando imagem de texto para rodapé...`);
  const txtFile = 'descricao.txt';
  fs.writeFileSync(txtFile, texto);
  registrarTemporario(txtFile);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black@0.0:size=640x100',
    '-vf', `drawtext=textfile=${txtFile}:fontcolor=white:fontsize=36:font=Arial:fontweight=900:text_shadowncolor=black:x=10:y=30`,
    '-frames:v', '1',
    output
  ]);
  registrarTemporario(output);
}

async function gerarRodapeFundo(output) {
  console.log('🎨 Gerando fundo de rodapé com gradiente...');
  // Criar gradiente no ffmpeg é complicado, então vamos fazer uma cor preta semi-transparente para efeito similar
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black@0.6:size=1280x100',
    '-t', '60',
    '-r', '30',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuva420p',
    output
  ]);
  registrarTemporario(output);
}

// Aplica rodapé com efeito suave (fade in e fade out no Y) entre 360 e 420s (6 a 7 min)
async function aplicarRodape(input, output, rodapeFundo, rodapeTexto, logo) {
  console.log('🎥 Aplicando rodapé com efeito de slide suave e logo...');
  
  // Overlay do rodapé no fundo com animação Y (slide up/down) e fade, só aparece entre 360 e 420s (6-7 minutos)
  // O logo aparece sempre no topo direito, mas somente no vídeo principal (usar input para decidir)
  
  // Para o overlay animado no eixo Y, fórmula:
  // y = if(between(t,360,361), H - (t-360)*100, if(between(t,361,419), H - 100, if(between(t,419,420), H - 100 + (t-419)*100, NAN)))
  // Isso faz slide para dentro em 1s, mantém 6min (360-419s), e slide para fora em 1s

  const overlayRodape = `[0:v][1:v]overlay=0:'if(between(t,360,361), H-(t-360)*100, if(between(t,361,419), H-100, if(between(t,419,420), H-100+(t-419)*100, NAN)))':enable='between(t,360,420)'[tmp1]`;

  // Logo no canto superior direito, 10px da borda, tamanho máximo 10% da largura
  // Usar scale e overlay
  const overlayLogo = `[tmp1][2:v]overlay=W-w-10:10:enable='between(t,0,9999)'`;

  // Concatenar filter_complex
  const filterComplex = `${overlayRodape};${overlayLogo}`;

  await executarFFmpeg([
    '-i', input,
    '-i', rodapeFundo,
    '-i', logo,
    '-filter_complex', filterComplex,
    '-c:a', 'copy',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-movflags', '+faststart',
    output
  ]);

  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  console.log('🔗 Unindo vídeos...');
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`🎬 Vídeo final criado: ${saida}`);
}

(async () => {
  try {
    console.log('📦 Lendo input.json...');
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const camposObrigatorios = [
      'id',
      'video_principal',
      'logo_id',
      'rodape_id',
      'video_inicial',
      'video_miraplay',
      'video_final',
    ];

    const camposVazios = camposObrigatorios.filter(campo => {
      const valor = dados[campo];
      return valor === undefined || valor === null || valor === '';
    });

    if (camposVazios.length > 0) {
      console.error('❌ Os seguintes campos obrigatórios estão vazios ou ausentes:');
      camposVazios.forEach(campo => console.error(` - ${campo}`));
      throw new Error('❌ input.json está incompleto. Corrija os campos acima.');
    }

    console.log('✅ Todos os campos obrigatórios estão preenchidos.');

    const {
      video_principal,
      id,
      logo_id,
      rodape_id,
      rodape_texto = '',
      video_inicial,
      video_miraplay,
      videos_extras = [],
      video_final
    } = dados;

    // Baixa rodapé e logo
    await baixarArquivo(rodape_id, 'footer.png', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);

    // Gera imagem do texto do rodapé (ou transparente se vazio)
    if (rodape_texto.trim().length > 0) {
      await gerarImagemTexto(rodape_texto, 'texto.png');
    } else {
      console.log('⚠️ rodape_texto vazio, gerando imagem transparente.');
      await executarFFmpeg(['-f', 'lavfi', '-i', 'color=black@0.0:size=640x100', '-frames:v', '1', 'texto.png']);
      registrarTemporario('texto.png');
    }

    // Baixa vídeo principal
    await baixarArquivo(video_principal, 'principal.mp4', auth);
    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    // Divide vídeo principal em duas partes
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    // Reencode as partes cortadas para garantir compatibilidade
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    // Aplica rodapé com efeito e logo somente na parte 1 e 2 do vídeo principal
    await aplicarRodape('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'texto.png', 'logo.png');
    await aplicarRodape('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'texto.png', 'logo.png');

    // Monta lista de vídeos para concat
    // Conforme sua regra:
    // video_inicial, video_miraplay, videos_extras..., video_inicial (de novo), parte2_final.mp4, video_final
    const videoIds = [
      video_inicial,
      video_miraplay,
      ...videos_extras,
      video_inicial,
      'parte2_final.mp4',
      video_final
    ];

    // Lista para armazenar nomes de arquivos prontos para concat
    const arquivosProntos = ['parte1_final.mp4'];

    // Processa todos os vídeos da lista videoIds
    for (let i = 0; i < videoIds.length; i++) {
      const vid = videoIds[i];

      // Se já for arquivo local (ex: parte2_final.mp4), adiciona direto
      if (fs.existsSync(vid)) {
        arquivosProntos.push(vid);
        continue;
      }

      // Senão, baixa e reencode
      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;

      await baixarArquivo(vid, raw, auth);
      await reencode(raw, final);

      arquivosProntos.push(final);
    }

    // Une todos os vídeos em um arquivo final
    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    // Salva info de streaming
    fs.writeFileSync('stream_info.json', JSON.stringify({ video_id: id }, null, 2));

    console.log('🎉 Processo concluído com sucesso! Vídeo final: video_final_completo.mp4');

  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
