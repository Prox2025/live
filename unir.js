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

function esperarArquivo(caminho, tentativas = 15, intervalo = 1000) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const verificar = () => {
      if (fs.existsSync(caminho)) {
        resolve();
      } else if (++count > tentativas) {
        reject(new Error(`❌ Arquivo não disponível após ${tentativas} tentativas: ${caminho}`));
      } else {
        setTimeout(verificar, intervalo);
      }
    };
    verificar();
  });
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

async function obterDuracao(video) {
  const { stdout } = await exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${video}"`);
  return parseFloat(stdout.trim());
}

async function baixarEReencodar(remoto, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', ['copy', `meudrive:${remoto}`, '.', '--config', keyFile]);

    rclone.stderr.on('data', data => process.stderr.write(data));

    rclone.on('close', async code => {
      const nome = path.basename(remoto);
      if (code === 0 && fs.existsSync(nome)) {
        fs.renameSync(nome, destino);
        registrarTemporario(destino);
        const temp = destino.replace(/(\.[^.]+)$/, '_temp$1');
        await executarFFmpeg(['-i', destino, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', temp], temp);
        fs.renameSync(temp, destino);
        console.log(`📥 Vídeo baixado e reencodificado: ${destino}`);
        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function aplicarRodapeELogo(videoEntrada, rodape, logo, saidaFinal) {
  const durRodape = await obterDuracao(rodape);
  const filtro = `
    [0:v]scale=1280:720,setsar=1[v0];
    [1:v]scale=1280:100[rod];
    [2:v]scale=100:100[logo];
    [v0][rod]overlay=0:H-h:enable='between(t,0,${durRodape})'[v1];
    [v1][logo]overlay=W-w-10:10[outv]
  `.replace(/\s+/g, '');

  await executarFFmpeg([
    '-i', videoEntrada,
    '-i', rodape,
    '-i', logo,
    '-filter_complex', filtro,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    saidaFinal
  ], saidaFinal);
}

async function dividirPrincipal(videoPrincipal) {
  const parte1 = 'parte1.mp4';
  const parte2 = 'parte2.mp4';
  const duracao = await obterDuracao(videoPrincipal);
  const metade = duracao / 2;
  await executarFFmpeg(['-i', videoPrincipal, '-t', metade.toFixed(2), parte1], parte1);
  await executarFFmpeg(['-i', videoPrincipal, '-ss', metade.toFixed(2), parte2], parte2);
  return [parte1, parte2];
}

async function normalizarVideo(videoEntrada, videoSaida) {
  if (!fs.existsSync(videoEntrada)) throw new Error(`❌ Arquivo ausente: ${videoEntrada}`);
  await executarFFmpeg([
    '-i', videoEntrada,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-vf', 'scale=1280:720',
    videoSaida
  ], videoSaida);
}

async function unirVideos(lista, saida) {
  const listaTxt = 'lista_completa.txt';
  fs.writeFileSync(listaTxt, lista.map(v => `file '${v}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', saida], saida);
}

(async () => {
  const { video_principal, rodape_id, logo_id, stream_url, video_inicial, video_miraplay, video_final } = input;

  console.log('⏬ Baixando e processando principal...');
  await baixarEReencodar(video_principal, 'principal.mp4');
  const [parte1, parte2] = await dividirPrincipal('principal.mp4');

  await baixarEReencodar(rodape_id, 'rodape.mp4');
  await baixarEReencodar(logo_id, 'logo.png');

  console.log('🎥 Aplicando rodapé e logo nas partes principais...');
  await aplicarRodapeELogo(parte1, 'rodape.mp4', 'logo.png', 'parte1_completo.mp4');
  await aplicarRodapeELogo(parte2, 'rodape.mp4', 'logo.png', 'parte2_completo.mp4');

  const outros = [
    { id: video_inicial, out: 'inicial_normalizado.mp4' },
    { id: video_miraplay, out: 'miraplay_normalizado.mp4' },
    { id: video_final, out: 'final_normalizado.mp4' },
  ];

  for (const item of outros) {
    await baixarEReencodar(item.id, item.out.replace('_normalizado.mp4', '.mp4'));
    await normalizarVideo(item.out.replace('_normalizado.mp4', '.mp4'), item.out);
  }

  const extras = [];
  for (let i = 0; i < input.videos_extras.length; i++) {
    const nome = `extra_${i}.mp4`;
    const nomeNorm = `extra_${i}_normalizado.mp4`;
    await baixarEReencodar(input.videos_extras[i], nome);
    await normalizarVideo(nome, nomeNorm);
    extras.push(nomeNorm);
  }

  const ordem = [
    'parte1_completo.mp4',
    'inicial_normalizado.mp4',
    'miraplay_normalizado.mp4',
    ...extras,
    'inicial_normalizado.mp4',
    'parte2_completo.mp4',
    'final_normalizado.mp4'
  ];

  console.log('🎬 Unindo vídeos...');
  await unirVideos(ordem, 'video_final_completo.mp4');

  console.log('📝 Salvando informações de transmissão...');
  fs.writeFileSync('stream_info.json', JSON.stringify({ id: input.id, stream_url }, null, 2));

  if (fs.existsSync('video_final_completo.mp4')) {
    const stats = fs.statSync('video_final_completo.mp4');
    const duracao = await obterDuracao('video_final_completo.mp4');
    console.log(`✅ Finalizado com ${Math.round(stats.size / 1024 / 1024)} MB e duração ${duracao.toFixed(2)}s`);
  } else {
    console.error('❌ video_final_completo.mp4 não encontrado');
  }
})();
