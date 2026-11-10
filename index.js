const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ChannelType, 
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const crc = require('crc');

// 1. Configurações de Ambiente
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PIX_CONFIG = {
  key: process.env.PIX_KEY,
  name: process.env.PIX_NAME,
  city: process.env.PIX_CITY
};

// 2. Gerador de Payload Pix EMV (Copia e Cola)
function formatEMV(id, value) {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

function generatePixPayload(key, name, city, amount, txid) {
  const cleanKey = key.trim();
  const cleanName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").substring(0, 25);
  const cleanCity = city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").substring(0, 15);
  const cleanTxid = txid.replace(/[^a-zA-Z0-9]/g, '').substring(0, 25) || '***';
  const formattedAmount = Number(amount).toFixed(2);

  const merchantAccount = [
    formatEMV('00', 'BR.GOV.BCB.PIX'),
    formatEMV('01', cleanKey)
  ].join('');

  const additionalData = formatEMV('05', cleanTxid);

  let payload = [
    formatEMV('00', '01'),
    formatEMV('26', merchantAccount),
    formatEMV('52', '0000'),
    formatEMV('53', '986'),
    formatEMV('54', formattedAmount),
    formatEMV('58', 'BR'),
    formatEMV('59', cleanName),
    formatEMV('60', cleanCity),
    formatEMV('62', additionalData),
    '6304'
  ].join('');

  const crc16Hex = crc.crc16ccitt(payload).toString(16).toUpperCase().padStart(4, '0');
  return payload + crc16Hex;
}

// 3. Registo de Comandos Slash
const commands = [
  new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Exibe o catálogo de produtos disponíveis para compra.'),
  new SlashCommandBuilder()
    .setName('pedidos')
    .setDescription('Gerencia e lista os pedidos efetuados (Apenas para Creators).'),
  new SlashCommandBuilder()
    .setName('criar-produto')
    .setDescription('Cadastra um novo produto na loja (Apenas Administradores)')
    .addStringOption(option => 
      option.setName('nome')
        .setDescription('Nome do produto')
        .setRequired(true))
    .addNumberOption(option => 
      option.setName('preco')
        .setDescription('Preço do produto (ex: 15.50)')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('descricao')
        .setDescription('Descrição do produto')
        .setRequired(false))
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Comandos Slash registrados com sucesso!');
  } catch (err) {
    console.error('Erro ao registrar comandos:', err);
  }
}

// 4. Evento Ready
client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
  registerCommands();
});

// 5. Manipulação de Interações (Slash & Botões)
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // COMANDO: /comprar
    if (commandName === 'comprar') {
      await interaction.deferReply({ ephemeral: true });

      const { data: products, error } = await supabase.from('products').select('*');
      if (error || !products || products.length === 0) {
        return interaction.editReply({ content: 'Nenhum produto cadastrado no catálogo no momento.' });
      }

      let page = 0;

      const renderEmbed = (index) => {
        const item = products[index];
        const embed = new EmbedBuilder()
          .setTitle(item.name)
          .setDescription(item.description || 'Sem descrição disponível.')
          .addFields({ name: 'Preço', value: `R$ ${Number(item.price).toFixed(2)}`, inline: true })
          .setFooter({ text: `Produto ${index + 1} de ${products.length}` })
          .setColor(0x00FF00);

        if (item.image_url) embed.setImage(item.image_url);
        return embed;
      };

      const renderButtons = (index) => {
        return new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev').setLabel('◀ Anterior').setStyle(ButtonStyle.Primary).setDisabled(index === 0),
          new ButtonBuilder().setCustomId(`buy_${products[index].id}`).setLabel('🛒 Comprar').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('next').setLabel('Próximo ▶').setStyle(ButtonStyle.Primary).setDisabled(index === products.length - 1)
        );
      };

      const msg = await interaction.editReply({
        embeds: [renderEmbed(page)],
        components: [renderButtons(page)],
        fetchReply: true
      });

      const collector = msg.createMessageComponentCollector({ time: 300000 });

      collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({ content: 'Abra o seu próprio menu de compra usando /comprar.', ephemeral: true });
        }

        if (i.customId === 'prev') {
          page--;
          await i.update({ embeds: [renderEmbed(page)], components: [renderButtons(page)] });
        } else if (i.customId === 'next') {
          page++;
          await i.update({ embeds: [renderEmbed(page)], components: [renderButtons(page)] });
        } else if (i.customId.startsWith('buy_')) {
          await i.deferUpdate();
          const prodId = i.customId.split('_')[1];
          const product = products.find(p => p.id == prodId);

          // Criar canal privado
          const channel = await interaction.guild.channels.create({
            name: `compra-${i.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
              { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
              { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
              { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
          });

          // Registrar no Banco de Dados
          const { data: order } = await supabase.from('orders').insert({
            user_id: i.user.id,
            user_name: i.user.username,
            product_id: product.id,
            product_name: product.name,
            amount: product.price,
            channel_id: channel.id,
            status: 'PENDENTE'
          }).select().single();

          // Gerar Pix
          const pixCode = generatePixPayload(
            PIX_CONFIG.key,
            PIX_CONFIG.name,
            PIX_CONFIG.city,
            product.price,
            i.user.username
          );

          const pixEmbed = new EmbedBuilder()
            .setTitle(`Pagamento Pix - Pedido #${order.id}`)
            .setDescription(`Olá ${i.user}, obrigado pelo pedido!\n\n**Produto:** ${product.name}\n**Valor:** R$ ${Number(product.price).toFixed(2)}\n\nUse o código Copia e Cola abaixo para efetuar o pagamento:`)
            .setColor(0xFFFF00);

          await channel.send({ embeds: [pixEmbed] });
          await channel.send({ content: `\`\`\`${pixCode}\`\`\`` });

          await interaction.followUp({ content: `Seu carrinho foi aberto! Acesse o canal ${channel}`, ephemeral: true });
        }
      });
    }

    // COMANDO: /pedidos
    if (commandName === 'pedidos') {
      const hasPermission = interaction.member.roles.cache.some(role => 
        role.name === 'Creator' || role.name === 'Creator 2'
      );

      if (!hasPermission) {
        return interaction.reply({ content: 'Você não tem permissão para usar este comando. Cargo necessário: Creator ou Creator 2.', ephemeral: true });
      }

      const { data: orders, error } = await supabase.from('orders').select('*').eq('status', 'PENDENTE');

      if (error || !orders || orders.length === 0) {
        return interaction.reply({ content: 'Não há pedidos pendentes no momento.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      for (const order of orders) {
        const orderEmbed = new EmbedBuilder()
          .setTitle(`Pedido #${order.id}`)
          .addFields(
            { name: 'Cliente', value: `<@${order.user_id}> (${order.user_name})`, inline: true },
            { name: 'Produto', value: order.product_name, inline: true },
            { name: 'Valor', value: `R$ ${Number(order.amount).toFixed(2)}`, inline: true },
            { name: 'Status', value: order.status, inline: true }
          )
          .setColor(0x3498DB);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_${order.id}`).setLabel('Confirmar Compra').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`cancel_${order.id}`).setLabel('Recusar Compra').setStyle(ButtonStyle.Danger)
        );

        await interaction.followUp({ embeds: [orderEmbed], components: [row], ephemeral: true });
      }
  } // <-- Fim do comando /pedidos

  // COLA AQUI NA LINHA 261:
  if (commandName === 'criar-produto') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Apenas administradores podem cadastrar produtos.', ephemeral: true });
    }

    const nome = interaction.options.getString('nome');
    const preco = interaction.options.getNumber('preco');
    const descricao = interaction.options.getString('descricao') || 'Sem descrição';

    const { error } = await supabase
      .from('products')
      .insert([{ name: nome, price: preco, description: descricao }]);

    if (error) {
      console.error(error);
      return interaction.reply({ content: '❌ Erro ao cadastrar o produto no banco de dados.', ephemeral: true });
    }

    return interaction.reply({ content: `✅ Produto **${nome}** (R$ ${Number(preco).toFixed(2)}) cadastrado com sucesso!`, ephemeral: true });
  }
  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId.startsWith('confirm_') || customId.startsWith('cancel_')) {
      const isConfirm = customId.startsWith('confirm_');
      const orderId = customId.split('_')[1];

      const newStatus = isConfirm ? 'APROVADO' : 'RECUSADO';

      const { data: order } = await supabase
        .from('orders')
        .update({ status: newStatus })
        .eq('id', orderId)
        .select()
        .single();

      if (order) {
        await interaction.update({ content: `Pedido #${orderId} alterado para **${newStatus}**!`, embeds: [], components: [] });

        if (order.channel_id) {
          const ch = await interaction.guild.channels.fetch(order.channel_id).catch(() => null);
          if (ch) {
            if (isConfirm) {
              await ch.send(`✅ **Pagamento Confirmado!** O seu produto será entregue em breve.`);
            } else {
              await ch.send(`❌ **Pedido Recusado/Cancelado.**`);
            }
          }
        }
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
// Cole o servidor HTTP aqui no finalzinho:
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Online!');
});
server.listen(process.env.PORT || 3000);
