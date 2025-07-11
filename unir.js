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

async function aplicarRodape(videoInput, videoOutput) {
  await executarFFmpeg([
    '-i', videoInput,
    '-i', 'rodape.webm',
    '-filter_complex',
    "[1:v]format=rgba[ov];[0:v][ov]overlay=0:H-h-20:enable='gte(t,180)':format=auto:shortest=1[outv]",
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
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

  const arquivos = [];

  console.log('⏬ Baixando vídeos na ordem correta...');
  await baixarArquivo(input.video_principal, 'parte1_original.mp4', auth);
  await baixarArquivo(input.video_principal, 'parte2_original.mp4', auth);

  if (input.rodape_id) {
    console.log('⏬ Baixando rodapé transparente (.webm)...');
    await baixarArquivo(input.rodape_id, 'rodape.webm', auth);

    console.log('🖼️ Aplicando rodapé em parte1...');
    await aplicarRodape('parte1_original.mp4', 'parte1_com_rodape.mp4');

    console.log('🖼️ Aplicando rodapé em parte2...');
    await aplicarRodape('parte2_original.mp4', 'parte2_com_rodape.mp4');

    arquivos.push('parte1_com_rodape.mp4');
  } else {
    arquivos.push('parte1_original.mp4');
  }

  await baixarArquivo(input.video_inicial, 'inicial1.mp4', auth);
  arquivos.push('inicial1.mp4');

  await baixarArquivo(input.video_miraplay, 'miraplay.mp4', auth);
  arquivos.push('miraplay.mp4');

  if (input.videos_extras && Array.isArray(input.videos_extras)) {
    for (let i = 0; i < input.videos_extras.length && i < 5; i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome, auth);
      arquivos.push(nome);
    }
  }

  await baixarArquivo(input.video_inicial, 'inicial2.mp4', auth);
  arquivos.push('inicial2.mp4');

  if (input.rodape_id) {
    arquivos.push('parte2_com_rodape.mp4');
  } else {
    arquivos.push('parte2_original.mp4');
  }

  await baixarArquivo(input.video_final, 'final.mp4', auth);
  arquivos.push('final.mp4');

  if (input.logo_id) {
    await baixarArquivo(input.logo_id, 'logo.png', auth);
  }

  // Reencodificação para 1280x720
  console.log('🎞️ Reencodificando vídeos...');
  const convertidos = [];

  for (const [index, original] of arquivos.entries()) {
    const convertido = `convertido_${index}.mp4`;
    await executarFFmpeg([
      '-i', original,
      '-vf', 'scale=1280:720',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      convertido
    ]);
    registrarTemporario(convertido);
    convertidos.push(convertido);
  }

  // Concatenar vídeos
  const listaConcat = 'videos.txt';
  fs.writeFileSync(listaConcat, convertidos.map(c => `file '${c}'`).join('\n'));
  registrarTemporario(listaConcat);

  console.log('🧩 Unindo vídeos...');
  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c', 'copy',
    'video_unido.mp4'
  ]);

  // Aplicar logo
  if (fs.existsSync('logo.png')) {
    console.log('📎 Aplicando logo no canto superior direito...');
    await executarFFmpeg([
      '-i', 'video_unido.mp4',
      '-i', 'logo.png',
      '-filter_complex',
      '[1]scale=15:-1[logo];[0][logo]overlay=W-w-10:10',
      '-c:a', 'copy',
      'video_final_completo.mp4'
    ]);
  } else {
    fs.renameSync('video_unido.mp4', 'video_final_completo.mp4');
  }

  // Criar stream_info.json
  const streamInfo = {
    id: input.id,
    data: new Date().toISOString(),
    video: 'video_final_completo.mp4',
    resolucao: '1280x720',
    ordem: [
      'parte1 (com rodapé)',
      'video_inicial',
      'video_miraplay',
      ...(input.videos_extras || []).map((_, i) => `extra${i + 1}`),
      'video_inicial (repetido)',
      'parte2 (com rodapé)',
      'video_final'
    ]
  };
  fs.writeFileSync('stream_info.json', JSON.stringify(streamInfo, null, 2));

  console.log('✅ Vídeo final salvo como: video_final_completo.mp4');
  console.log('📄 stream_info.json criado com dados da execução.');

  limparTemporarios();
}

main().catch(err => {
  console.error('🚨 Erro fatal:', err);
  process.exit(1);
});
