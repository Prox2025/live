const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const input = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarFFmpeg(args, outputLabel) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log(`✅ Criado: ${outputLabel}`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function reencode(entrada, saida) {
  await executarFFmpeg([
    '-i', entrada,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    saida
  ], saida);
}

async function obterDuracao(video) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${video}"`);
  return parseFloat(stdout.trim());
}

async function baixarArquivo(remoto, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', async code => {
      if (code === 0) {
        const nome = path.basename(remoto);
        if (!fs.existsSync(nome)) return reject(new Error(`Arquivo não encontrado: ${nome}`));
        fs.renameSync(nome, destino);
        registrarTemporario(destino);

        const extensao = path.extname(destino).toLowerCase();
        if (['.mp4', '.webm', '.mov'].includes(extensao)) {
          const temporario = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temporario);
          fs.renameSync(temporario, destino);
          console.log(`📥 Vídeo baixado e reencodado: ${destino}`);
        } else {
          console.log(`📥 Imagem baixada: ${destino}`);
        }

        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function aplicarRodapeELogoPartePrincipal(videoEntrada, rodape, logo, saidaFinal) {
  const durRodape = await obterDuracao(rodape);
  const tempoInicio = 240;
  const tempoFim = tempoInicio + durRodape;

  const filtro = `
    [0:v]scale=1280:720,setsar=1[vfull];
    [0:v]scale=960:540,setpts=PTS-STARTPTS[vmini];
    [1:v]scale=1280:180,setpts=PTS-STARTPTS[vrod];

    [vfull][vrod]overlay=0:540:enable='between(t,${tempoInicio},${tempoFim})'[vtemp];
    [vtemp][vmini]overlay=(W-w)/2:0:enable='between(t,${tempoInicio},${tempoFim})'[outv]
  `.replace(/\s+/g, '');

  await executarFFmpeg([
    '-i', videoEntrada,
    '-i', rodape,
    '-filter_complex', filtro,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    saidaFinal
  ], saidaFinal);
}

async function aplicarRodapeComoFundo(parte2, rodape, saida) {
  const filtro = `
    [0:v]scale=320:-1[mini];
    [1:v]scale=1280:720[bg];
    [bg][mini]overlay=W-w-51:H-h-65[outv]
  `.replace(/\s+/g, '');

  await executarFFmpeg([
    '-i', parte2,
    '-i', rodape,
    '-filter_complex', filtro,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    saida
  ], saida);
}

async function normalizarVideo(entrada, saida) {
  if (!fs.existsSync(entrada)) {
    throw new Error(`❌ Arquivo não encontrado: ${entrada}`);
  }

  await executarFFmpeg([
    '-i', entrada,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-vf', 'scale=1280:720',
    '-f', 'mp4',
    saida
  ], saida);
}

async function unirComRodape(listaVideos, saidaFinal) {
  const comandos = [];

  for (let i = 0; i < listaVideos.length; i++) {
    comandos.push('-i', listaVideos[i]);
  }

  const filtros = listaVideos.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
  const filtroFinal = `
    ${filtros}concat=n=${listaVideos.length}:v=1:a=1[v][a]
  `.replace(/\s+/g, '');

  await executarFFmpeg([
    ...comandos,
    '-filter_complex', filtroFinal,
    '-preset', 'veryfast',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-map', '[v]', '-map', '[a]',
    saidaFinal
  ], saidaFinal);
}

async function processarVideos() {
  const parte1 = 'parte1.mp4';
  const parte2 = 'parte2.mp4';

  if (!fs.existsSync(parte1) || !fs.existsSync(parte2)) {
    throw new Error(`❌ parte1.mp4 ou parte2.mp4 ausente.`);
  }

  await normalizarVideo(parte1, 'parte1_normalizado.mp4');
  await normalizarVideo(parte2, 'parte2_normalizado.mp4');

  await aplicarRodapeELogoPartePrincipal('parte1_normalizado.mp4', 'rodape.mp4', 'logo.png', 'parte1_completo.mp4');
  await aplicarRodapeComoFundo('parte2_normalizado.mp4', 'rodape.mp4', 'parte2_completo.mp4');

  const extras = input.videos_extras || [];
  for (let i = 0; i < extras.length; i++) {
    const nome = path.basename(extras[i]);
    await baixarArquivo(extras[i], nome);
    await normalizarVideo(nome, `extra_${i}_normalizado.mp4`);
  }

  await normalizarVideo('inicial.mp4', 'inicial_normalizado.mp4');
  await normalizarVideo('miraplay.mp4', 'miraplay_normalizado.mp4');
  await normalizarVideo('final.mp4', 'final_normalizado.mp4');

  const ordemFinal = [
    'parte1_completo.mp4',
    'inicial_normalizado.mp4',
    'miraplay_normalizado.mp4',
    ...extras.map((_, i) => `extra_${i}_normalizado.mp4`),
    'inicial_normalizado.mp4',
    'parte2_completo.mp4',
    'final_normalizado.mp4'
  ];

  await unirComRodape(ordemFinal, 'video_final_completo.mp4');
}

(async () => {
  const { video_principal, rodape_id, logo_id, stream_url } = input;

  await baixarArquivo(video_principal, 'principal.mp4');
  await baixarArquivo(input.video_inicial, 'inicial.mp4');
  await baixarArquivo(input.video_miraplay, 'miraplay.mp4');
  await baixarArquivo(input.video_final, 'final.mp4');
  await baixarArquivo(rodape_id, 'rodape.mp4');
  await baixarArquivo(logo_id, 'logo.png');

  await executarFFmpeg(['-i', 'principal.mp4', '-t', '00:08:00', '-c', 'copy', 'parte1.mp4'], 'parte1.mp4');
  await executarFFmpeg(['-i', 'principal.mp4', '-ss', '00:08:00', '-c', 'copy', 'parte2.mp4'], 'parte2.mp4');

  await processarVideos();

  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  fs.writeFileSync('stream_info.json', JSON.stringify({ id: input.id, stream_url }, null, 2));

  console.log(`✅ Finalizado com ${Math.round(stats.size / 1024 / 1024)} MB e duração ${duracaoFinal.toFixed(2)}s`);
})();
