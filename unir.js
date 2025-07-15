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

        if (['.mp4', '.webm', '.mov'].includes(extensao)) {
          const temporario = destino.replace(/(\.[^.]+)$/, '_temp$1');
          await reencode(destino, temporario);
          fs.renameSync(temporario, destino);
          console.log(`📥 Vídeo baixado e reencodado: ${destino}`);
        } else {
          console.log(`📥 Arquivo de imagem baixado: ${destino}`);
        }

        resolve();
      } else {
        reject(new Error(`Erro ao baixar ${remoto}`));
      }
    });
  });
}

// Função para aplicar o rodapé e logo apenas nas partes do vídeo principal (Parte 1 e Parte 2)
async function aplicarRodapeELogoPartePrincipal(videoEntrada, rodape, logo, saidaFinal) {
  const durRodape = await obterDuracao(rodape);
  const tempoInicioRodape = 240; // O rodapé começa no minuto 4 (240 segundos)

  const filtro = `
    [0:v]scale=1280:720,setsar=1[v0];
    [1:v]scale=1280:100[rod];
    [2:v]scale=100:100[logo];
    [v0][rod]overlay=0:H-h:enable='between(t,${tempoInicioRodape},${tempoInicioRodape + durRodape})'[v1];
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

// Função para normalizar os vídeos para garantir compatibilidade binária
async function normalizarVideo(videoEntrada, videoSaida) {
  await executarFFmpeg([
    '-i', videoEntrada,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-vf', 'scale=1280:720',
    '-f', 'mp4',
    videoSaida
  ], videoSaida);
}

// Função para normalizar todos os vídeos antes de processá-los
async function normalizarTodosVideos(videos) {
  for (let i = 0; i < videos.length; i++) {
    const videoEntrada = videos[i];
    const videoSaida = videoEntrada.replace('.mp4', '_normalizado.mp4');
    
    // Normaliza o vídeo para garantir compatibilidade binária
    await normalizarVideo(videoEntrada, videoSaida);
    console.log(`✅ Vídeo normalizado: ${videoSaida}`);
  }
}

// Função para unir os vídeos em um arquivo final
async function unirComRodape(listaDeVideos, saidaFinal) {
  const listaTxt = 'lista_completa.txt';

  // Cria um arquivo com a lista de vídeos normalizados para unir
  fs.writeFileSync(listaTxt, listaDeVideos.map(v => `file '${v}'`).join('\n'));

  // Une os vídeos normalizados
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', saidaFinal], saidaFinal);
}

// Função principal para processar vídeos
async function processarVideos() {
  const videosParaProcessar = [
    'parte1.mp4', 
    'parte2.mp4', 
    'inicial.mp4', 
    'miraplay.mp4', 
    ...input.videos_extras, 
    'final.mp4'
  ];

  console.log('🎥 Normalizando todos os vídeos...');
  await normalizarTodosVideos(videosParaProcessar);

  console.log('🎥 Aplicando rodapé e logo às partes principais...');
  // Aplica o rodapé e logo somente nas partes do vídeo principal (parte1 e parte2)
  await aplicarRodapeELogoPartePrincipal('parte1.mp4', 'rodape.mp4', 'logo.png', 'parte1_completo.mp4');
  await aplicarRodapeELogoPartePrincipal('parte2.mp4', 'rodape.mp4', 'logo.png', 'parte2_completo.mp4');

  // Para os outros vídeos (não principais), apenas normalizamos
  for (let video of ['inicial.mp4', 'miraplay.mp4', ...input.videos_extras, 'final.mp4']) {
    await normalizarVideo(video, video.replace('.mp4', '_normalizado.mp4'));
  }

  const ordemFinal = [
    'parte1_completo.mp4',
    'inicial_normalizado.mp4',
    'miraplay_normalizado.mp4',
    ...input.videos_extras.map((_, i) => `extra_${i}_normalizado.mp4`),
    'inicial_normalizado.mp4',
    'parte2_completo.mp4',
    'final_normalizado.mp4'
  ];

  console.log('🎬 Unindo vídeos...');
  await unirComRodape(ordemFinal, 'video_final_completo.mp4');

  console.log('✅ Vídeo final gerado!');
}

// Executar o processamento
(async () => {
  const { video_principal, rodape_id, logo_id, stream_url } = input;

  console.log('⏬ Baixando vídeos...');
  await baixarArquivo(video_principal, 'principal.mp4');
  await baixarArquivo(rodape_id, 'rodape.mp4');
  await baixarArquivo(logo_id, 'logo.png');

  console.log('🎬 Iniciando processamento...');
  await processarVideos();

  console.log('📝 Salvando informações de transmissão...');
  fs.writeFileSync('stream_info.json', JSON.stringify({ id: input.id, stream_url }, null, 2));

  const stats = fs.statSync('video_final_completo.mp4');
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  console.log(`✅ Vídeo final gerado com ${Math.round(stats.size / 1024 / 1024)} MB`);
  console.log(`⏱️ Duração total: ${duracaoFinal.toFixed(2)} segundos`);
})();
