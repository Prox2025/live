const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`🚨 ERRO: FFmpeg falhou (${code})`)));
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  arquivosTemporarios.forEach(arquivo => {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`🗑️ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao remover ${arquivo}: ${e.message}`);
    }
  });
}

async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(id, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    res.data.pipe(out);
    res.data.on('end', () => {
      registrarTemporario(destino);
      console.log(`📥 Baixado: ${destino}`);
      resolve();
    });
    res.data.on('error', reject);
  });
}

async function aplicarRodapeTransparente(videoInput, videoOutput) {
  await executarFFmpeg([
    '-i', videoInput,
    '-i', 'rodape.webm',
    '-filter_complex',
    "[1:v]format=rgba[ov];[0:v][ov]overlay=0:H-h:enable='gte(t,180)':format=auto:shortest=1[outv]",
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    videoOutput
  ]);
  registrarTemporario(videoOutput);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const auth = await autenticar();

  const partes = [];

  // Baixar vídeos
  console.log('⏬ Baixando vídeos...');
  await baixarArquivo(input.video_principal, 'parte1_raw.mp4', auth);  // parte 1
  await baixarArquivo(input.video_principal, 'parte2_raw.mp4', auth);  // parte 2

  if (input.rodape_id) {
    await baixarArquivo(input.rodape_id, 'rodape.webm', auth);

    console.log('🖼️ Aplicando rodapé em parte1...');
    await aplicarRodapeTransparente('parte1_raw.mp4', 'parte1.mp4');

    console.log('🖼️ Aplicando rodapé em parte2...');
    await aplicarRodapeTransparente('parte2_raw.mp4', 'parte2.mp4');
  } else {
    fs.renameSync('parte1_raw.mp4', 'parte1.mp4');
    fs.renameSync('parte2_raw.mp4', 'parte2.mp4');
  }

  partes.push('parte1.mp4');

  await baixarArquivo(input.video_inicial, 'inicial1.mp4', auth);
  partes.push('inicial1.mp4');

  await baixarArquivo(input.video_miraplay, 'miraplay.mp4', auth);
  partes.push('miraplay.mp4');

  if (Array.isArray(input.videos_extras)) {
    for (let i = 0; i < Math.min(input.videos_extras.length, 5); i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome, auth);
      partes.push(nome);
    }
  }

  await baixarArquivo(input.video_inicial, 'inicial2.mp4', auth);
  partes.push('inicial2.mp4');

  partes.push('parte2.mp4');

  await baixarArquivo(input.video_final, 'final.mp4', auth);
  partes.push('final.mp4');

  if (input.logo_id) {
    await baixarArquivo(input.logo_id, 'logo.png', auth);
  }

  // Reencodificação um a um
  console.log('🎞️ Reencodificando vídeos...');
  const convertidos = [];
  for (const [idx, entrada] of partes.entries()) {
    const saida = `convertido_${idx}.mp4`;
    await executarFFmpeg([
      '-i', entrada,
      '-vf', 'scale=1280:720',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      saida
    ]);
    registrarTemporario(saida);
    convertidos.push(saida);
  }

  // Gerar lista para concatenação com filter_complex
  const inputs = [];
  const maps = [];
  for (let i = 0; i < convertidos.length; i++) {
    inputs.push('-i', convertidos[i]);
    maps.push(`[${i}:v:0][${i}:a:0]`);
  }

  const concatFilter = maps.join('') + `concat=n=${convertidos.length}:v=1:a=1[outv][outa]`;

  const videoFinal = 'video_unido.mp4';

  await executarFFmpeg([
    ...inputs,
    '-filter_complex', concatFilter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    videoFinal
  ]);

  // Aplicar logo (aumentado para 60px)
  if (fs.existsSync('logo.png')) {
    console.log('📎 Aplicando logo...');
    await executarFFmpeg([
      '-i', videoFinal,
      '-i', 'logo.png',
      '-filter_complex',
      '[1]scale=-1:25[logo];[0][logo]overlay=W-w-10:10',
      '-c:a', 'copy',
      'video_final_completo.mp4'
    ]);
  } else {
    fs.renameSync(videoFinal, 'video_final_completo.mp4');
  }

  // Criar stream_info.json
  const streamInfo = {
    id: input.id || null,
    stream_url: input.stream_url || null,
    video: 'video_final_completo.mp4',
    resolucao: '1280x720',
    ordem: [
      'parte1 (rodapé)',
      'video_inicial',
      'video_miraplay',
      ...(input.videos_extras || []).map((_, i) => `extra${i + 1}`),
      'video_inicial (repetido)',
      'parte2 (rodapé)',
      'video_final'
    ]
  };

  fs.writeFileSync('stream_info.json', JSON.stringify(streamInfo, null, 2));
  console.log('✅ Vídeo final: video_final_completo.mp4');
  console.log('📄 stream_info.json salvo.');

  limparTemporarios();
}

main().catch(err => {
  console.error('🚨 Erro:', err);
  process.exit(1);
});
