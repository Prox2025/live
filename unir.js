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

async function dividirVideo(video, parte1, parte2) {
  const duracao = await obterDuracao(video);
  const metade = duracao / 2;

  await executarFFmpeg(['-i', video, '-t', metade.toFixed(2), parte1], parte1);
  await executarFFmpeg(['-i', video, '-ss', metade.toFixed(2), parte2], parte2);
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

        // Só reencoda se o arquivo for vídeo (mp4, webm, mov)
        if (['.mp4', '.webm', '.mov'].includes(extensao)) {
          const temporario = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temporario);
          fs.renameSync(temporario, destino);
          console.log(`📥 Vídeo baixado e reencodado: ${destino}`);
        } else {
          // Caso contrário, apenas loga que é uma imagem ou outro arquivo
          console.log(`📥 Arquivo de imagem baixado: ${destino}`);
        }

        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

async function adicionarLogoERodape(video, saida, rodape, logo, tempoRodape) {
  const duracaoRodape = await obterDuracao(rodape);

  const filtros = [
    `[0:v]scale=1280:720[base]`,
    `[1:v]scale=150:150[logo]`,
    `[2:v]scale=iw/1.7:ih/1.7[rod]`,
    `[base][logo]overlay=W-w-20:20[tmp1]`,
    `[tmp1][rod]overlay=enable='between(t,${tempoRodape},${tempoRodape + duracaoRodape})':(W-w)/2:(H-h)/2`
  ];

  await executarFFmpeg([
    '-i', video,
    '-i', logo,
    '-i', rodape,
    '-filter_complex', filtros.join(';'),
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'veryfast',
    saida
  ], saida);
}

async function unirVideos(lista, saidaFinal) {
  const listaTxt = 'lista.txt';
  fs.writeFileSync(listaTxt, lista.map(v => `file '${v}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', saidaFinal], saidaFinal);
}

(async () => {
  const {
    id, video_principal, rodape_id, rodape_texto,
    video_inicial, video_miraplay, video_final,
    logo_id, videos_extras, stream_url
  } = input;

  console.log('⏬ Baixando vídeos principais...');
  await baixarArquivo(video_principal, 'principal.mp4');
  await dividirVideo('principal.mp4', 'parte1.mp4', 'parte2.mp4');

  await baixarArquivo(rodape_id, 'rodape.mp4');
  await baixarArquivo(logo_id, 'logo.png');
  await baixarArquivo(video_inicial, 'inicial.mp4');
  await baixarArquivo(video_miraplay, 'miraplay.mp4');
  await baixarArquivo(video_final, 'final.mp4');

  console.log('🎥 Reencodificando partes com logo e rodapé...');
  await adicionarLogoERodape('parte1.mp4', 'parte1_final.mp4', 'rodape.mp4', 'logo.png', 240);
  await adicionarLogoERodape('parte2.mp4', 'parte2_final.mp4', 'rodape.mp4', 'logo.png', 240);

  const extras = [];
  if (Array.isArray(videos_extras)) {
    for (let i = 0; i < videos_extras.length; i++) {
      const nome = `extra_${i}.mp4`;
      await baixarArquivo(videos_extras[i], nome);
      extras.push(nome);
    }
  }

  const ordemFinal = [
    'parte1_final.mp4',
    'inicial.mp4',
    'miraplay.mp4',
    ...extras,
    'inicial.mp4',
    'parte2_final.mp4',
    'final.mp4'
  ];

  console.log('🎬 Montando vídeo final...');
  await unirVideos(ordemFinal, 'video_final_completo.mp4');

  console.log('📝 Salvando informações de transmissão...');
  fs.writeFileSync('stream_info.json', JSON.stringify({ id, stream_url }, null, 2));

  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  console.log(`✅ Vídeo final gerado com ${Math.round(stats.size / 1024 / 1024)} MB`);
  console.log(`⏱️ Duração total: ${duracaoFinal.toFixed(2)} segundos`);
})();
