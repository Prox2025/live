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

// ✅ APLICA LOGO + RODAPÉ TRANSPARENTE SOMENTE NAS PARTES PRINCIPAIS
async function aplicarLogoRodape(videoInput, videoOutput) {
  await executarFFmpeg([
    '-i', videoInput,
    '-i', 'logo.png',
    '-i', 'rodape.webm',
    '-filter_complex',
    "[0:v]scale=1280:720,format=rgba[base];" +
    "[1:v]scale=-1:80[logo];" +
    "[2:v]format=rgba,setpts=PTS-STARTPTS+240/TB[rodape];" +
    "[base][logo]overlay=W-w-20:20[tmp1];" +
    "[tmp1][rodape]overlay=x=(W-w)/2:y=H-h:enable='between(t,240,240+duration)'[outv]",
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-y',
    videoOutput
  ]);
  registrarTemporario(videoOutput);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const auth = await autenticar();
  const partes = [];

  // Baixar vídeos principais
  await baixarArquivo(input.video_principal, 'parte1_raw.mp4', auth);
  await baixarArquivo(input.video_principal, 'parte2_raw.mp4', auth);

  await baixarArquivo(input.rodape_id, 'rodape.webm', auth);
  await baixarArquivo(input.logo_id, 'logo.png', auth);

  // Aplicar logo + rodapé nas partes principais
  await aplicarLogoRodape('parte1_raw.mp4', 'parte1.mp4');
  await aplicarLogoRodape('parte2_raw.mp4', 'parte2.mp4');

  partes.push('parte1.mp4');

  // Demais vídeos
  await baixarArquivo(input.video_inicial, 'inicial1.mp4', auth); partes.push('inicial1.mp4');
  await baixarArquivo(input.video_miraplay, 'miraplay.mp4', auth); partes.push('miraplay.mp4');

  if (Array.isArray(input.videos_extras)) {
    for (let i = 0; i < Math.min(input.videos_extras.length, 5); i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome, auth);
      partes.push(nome);
    }
  }

  await baixarArquivo(input.video_inicial, 'inicial2.mp4', auth); partes.push('inicial2.mp4');

  partes.push('parte2.mp4');

  await baixarArquivo(input.video_final, 'final.mp4', auth); partes.push('final.mp4');

  // Reencodificar todos os vídeos (padronização)
  console.log('🎞️ Reencodificando vídeos com codec e proporção padronizados...');
  const reencodificados = [];

  for (const [i, entrada] of partes.entries()) {
    const saida = `reencode_${i}.mp4`;
    await executarFFmpeg([
      '-i', entrada,
      '-vf', 'scale=1280:720,fps=30',
      '-r', '30',
      '-g', '60',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-y',
      saida
    ]);
    registrarTemporario(saida);
    reencodificados.push(saida);
  }

  // Concatenação usando list.txt
  console.log('🧩 Concatenando vídeos com concat -f...');
  const listaTxt = 'list.txt';
  fs.writeFileSync(listaTxt, reencodificados.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(listaTxt);

  await executarFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', listaTxt,
    '-c', 'copy',
    'video_final_completo.mp4'
  ]);

  // Criar arquivo de informações do stream
  const streamInfo = {
    id: input.id,
    video: 'video_final_completo.mp4',
    stream_url: input.stream_url || null,
    resolucao: '1280x720',
    ordem: [
      'parte1 (logo + rodapé)',
      'inicial',
      'miraplay',
      ...(input.videos_extras || []).map((_, i) => `extra${i + 1}`),
      'inicial (repetido)',
      'parte2 (logo + rodapé)',
      'final'
    ]
  };

  fs.writeFileSync('stream_info.json', JSON.stringify(streamInfo, null, 2));
  console.log('✅ Finalizado: video_final_completo.mp4');
  console.log('📄 stream_info.json salvo');

  limparTemporarios();
}

main().catch(err => {
  console.error('🚨 Erro fatal:', err);
  limparTemporarios();
  process.exit(1);
});
