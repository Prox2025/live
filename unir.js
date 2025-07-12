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

async function reencodificar(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-r', '30',
    '-g', '60',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarRodape(videoInput, rodape, videoOutput) {
  await executarFFmpeg([
    '-i', videoInput,
    '-i', rodape,
    '-filter_complex',
    "[1:v]format=rgba[ov];[0:v][ov]overlay=0:H-h:enable='gte(t,180)':format=auto:shortest=1[outv]",
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-b:a', '128k',
    videoOutput
  ]);
  registrarTemporario(videoOutput);
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let data = '';
    ff.stdout.on('data', chunk => data += chunk.toString());
    ff.on('close', code => {
      if (code === 0) resolve(parseFloat(data.trim()));
      else reject(new Error('Erro ao obter duração'));
    });
  });
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(v => `file '${v}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`🎬 Vídeo final criado: ${saida}`);

  const stats = fs.statSync(saida);
  const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);
  const duracaoFinal = await obterDuracao(saida);

  console.log(`⏱️ Duração final: ${duracaoFinal.toFixed(2)}s`);
  console.log(`📦 Tamanho final: ${tamanhoMB} MB`);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const auth = await autenticar();
  const partes = [];

  await baixarArquivo(input.video_principal, 'parte1_raw.mp4', auth);
  await baixarArquivo(input.video_principal, 'parte2_raw.mp4', auth);
  if (input.rodape_id) await baixarArquivo(input.rodape_id, 'rodape.webm', auth);

  console.log('🎬 Aplicando rodapé e reencodificando parte1...');
  const parte1_rodape = 'parte1.mp4';
  const parte2_rodape = 'parte2.mp4';

  if (input.rodape_id) {
    await aplicarRodape('parte1_raw.mp4', 'rodape.webm', parte1_rodape);
    await aplicarRodape('parte2_raw.mp4', 'rodape.webm', parte2_rodape);
  } else {
    await reencodificar('parte1_raw.mp4', parte1_rodape);
    await reencodificar('parte2_raw.mp4', parte2_rodape);
  }

  partes.push(parte1_rodape);
  await baixarArquivo(input.video_inicial, 'inicial1.mp4', auth); await reencodificar('inicial1.mp4', 'r_inicial1.mp4'); partes.push('r_inicial1.mp4');
  await baixarArquivo(input.video_miraplay, 'miraplay.mp4', auth); await reencodificar('miraplay.mp4', 'r_miraplay.mp4'); partes.push('r_miraplay.mp4');

  if (Array.isArray(input.videos_extras)) {
    for (let i = 0; i < Math.min(input.videos_extras.length, 5); i++) {
      const nome = `extra${i + 1}.mp4`;
      const convertido = `r_extra${i + 1}.mp4`;
      await baixarArquivo(input.videos_extras[i], nome, auth);
      await reencodificar(nome, convertido);
      partes.push(convertido);
    }
  }

  await baixarArquivo(input.video_inicial, 'inicial2.mp4', auth); await reencodificar('inicial2.mp4', 'r_inicial2.mp4'); partes.push('r_inicial2.mp4');
  partes.push(parte2_rodape);
  await baixarArquivo(input.video_final, 'final.mp4', auth); await reencodificar('final.mp4', 'r_final.mp4'); partes.push('r_final.mp4');

  if (input.logo_id) await baixarArquivo(input.logo_id, 'logo.png', auth);

  await unirVideos(partes, 'video_unido.mp4');

  if (fs.existsSync('logo.png')) {
    console.log('📎 Aplicando logo final...');
    await executarFFmpeg([
      '-i', 'video_unido.mp4',
      '-i', 'logo.png',
      '-filter_complex',
      '[1]scale=-1:100[logo];[0][logo]overlay=W-w-20:20',
      '-c:a', 'copy',
      'video_final_completo.mp4'
    ]);
  } else {
    fs.renameSync('video_unido.mp4', 'video_final_completo.mp4');
  }

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    video: 'video_final_completo.mp4',
    resolucao: '1280x720',
    stream_url: input.stream_url || null,
    ordem: ['parte1', 'inicial', 'miraplay', 'extras', 'inicial2', 'parte2', 'final']
  }, null, 2));

  console.log('✅ Finalizado com sucesso!');
  limparTemporarios();
}

main().catch(err => {
  console.error('🚨 Erro fatal:', err);
  process.exit(1);
});
