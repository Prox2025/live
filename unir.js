const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const keyFile = process.env.KEYFILE || 'rclone.conf';
const inputFile = process.env.INPUTFILE || 'input.json';

const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarFFmpeg(args, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        if (output) console.log(`✅ Criado: ${output}`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function baixarArquivo(caminhoRclone, destino) {
  if (!caminhoRclone) throw new Error(`❌ Caminho ausente para ${destino}`);

  return new Promise((resolve, reject) => {
    // Atenção: sem chaves {}, usar caminho direto no remote
    const rclone = spawn('rclone', ['copy', `meudrive:${caminhoRclone}`, '.', '--config', keyFile]);

    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', code => {
      if (code === 0) {
        // Procurar arquivo baixado com o nome original (última parte do caminho)
        const nomeArquivo = path.basename(caminhoRclone);
        if (!fs.existsSync(nomeArquivo)) {
          return reject(new Error(`❌ Arquivo não encontrado após download: ${nomeArquivo}`));
        }
        fs.renameSync(nomeArquivo, destino);
        registrarTemporario(destino);
        console.log(`📥 Baixado via rclone: ${destino}`);
        resolve();
      } else {
        reject(new Error(`❌ rclone falhou ao baixar ${caminhoRclone}`));
      }
    });
  });
}

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => resolve(parseFloat(data.trim())));
    ffprobe.on('error', reject);
  });
}

async function cortarTrecho(input, inicio, duracao, output) {
  await executarFFmpeg([
    '-i', input,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
}

async function aplicarLogo(input, output) {
  if (!fs.existsSync('logo.png')) {
    fs.copyFileSync(input, output);
    return;
  }

  await executarFFmpeg([
    '-i', input,
    '-i', 'logo.png',
    '-filter_complex',
    '[1:v]scale=iw/7:-1[logo];[0:v][logo]overlay=W-w-10:10',
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
}

async function inserirRodape(video, rodape, saida, tempoRodape, pontoInsercao) {
  const antes = saida + '_antes.mp4';
  const depois = saida + '_depois.mp4';
  const trechoComRodape = saida + '_trecho.mp4';
  const combinado = saida + '_combinado.mp4';

  await cortarTrecho(video, 0, pontoInsercao, antes);
  await cortarTrecho(video, pontoInsercao + tempoRodape, 9999, depois);
  await cortarTrecho(video, pontoInsercao, tempoRodape, trechoComRodape);

  // Aplicar redimensionamento + rodapé
  await executarFFmpeg([
    '-i', trechoComRodape,
    '-i', rodape,
    '-filter_complex',
    `[0:v]scale=iw:ih*0.8,pad=iw:ih+ih*0.2:0:0[vid];[1:v]scale=iw:-1[rod];[vid][rod]overlay=0:H-h`,
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    combinado
  ], combinado);

  // Concatenar partes
  const listaConcat = saida + '_lista.txt';
  fs.writeFileSync(listaConcat, [
    `file '${path.resolve(antes)}'`,
    `file '${path.resolve(combinado)}'`,
    `file '${path.resolve(depois)}'`
  ].join('\n'));

  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaConcat, '-c', 'copy', saida], saida);
}

async function unirFinal(arquivos, saida) {
  const lista = 'lista_final.txt';
  fs.writeFileSync(lista, arquivos.map(p => `file '${path.resolve(p)}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', saida], saida);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(inputFile));

  if (input.rodape_id) {
    await baixarArquivo(input.rodape_id, 'rodape.mp4');
  } else {
    fs.writeFileSync('rodape.mp4', '');
  }

  const durRodape = input.rodape_id ? await obterDuracao('rodape.mp4') : 5;
  const ordem = [], extras = [];

  await baixarArquivo(input.video_principal, 'principal.mp4');

  const duracaoPrincipal = await obterDuracao('principal.mp4');
  const metade = Math.floor(duracaoPrincipal / 2);

  await cortarTrecho('principal.mp4', 0, metade, 'parte1.mp4');
  await inserirRodape('parte1.mp4', 'rodape.mp4', 'parte1_final.mp4', durRodape, 240);
  await aplicarLogo('parte1_final.mp4', 'parte1_logo.mp4');

  await cortarTrecho('principal.mp4', metade, duracaoPrincipal - metade, 'parte2.mp4');
  await inserirRodape('parte2.mp4', 'rodape.mp4', 'parte2_final.mp4', durRodape, 240);
  await aplicarLogo('parte2_final.mp4', 'parte2_logo.mp4');

  for (let i = 0; i < (input.videos_extras || []).length; i++) {
    const caminhoExtra = input.videos_extras[i];
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(caminhoExtra, nome);
    extras.push(nome);
  }

  await baixarArquivo(input.video_inicial, 'inicial.mp4');
  await baixarArquivo(input.video_miraplay, 'miraplay.mp4');
  await baixarArquivo(input.video_final, 'final.mp4');

  ordem.push('parte1_logo.mp4');
  ordem.push('inicial.mp4');
  ordem.push('miraplay.mp4');
  ordem.push(...extras);
  ordem.push('inicial.mp4');
  ordem.push('parte2_logo.mp4');
  ordem.push('final.mp4');

  await unirFinal(ordem, 'video_final_completo.mp4');

  const stats = fs.statSync('video_final_completo.mp4');
  const duracao = await obterDuracao('video_final_completo.mp4');
  const tamanho = (stats.size / 1024 / 1024).toFixed(2);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream_url: input.stream_url,
    duracao,
    tamanho_mb: tamanho
  }, null, 2));

  console.log(`✅ Vídeo final pronto: video_final_completo.mp4`);
  console.log(`⏱️  Duração: ${duracao.toFixed(2)} segundos`);
  console.log(`💾 Tamanho: ${tamanho} MB`);
}

main().catch(err => {
  console.error('❌ Erro no processamento:', err);
  process.exit(1);
});
