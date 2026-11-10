require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Prevenir crash global por erros não tratados
process.on('unhandledRejection', error => {
    console.error('Erro não tratado detetado:', error);
});

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', async () => {
    console.log(`Bot ligado como ${client.user.tag}!`);

    const data = new SlashCommandBuilder()
        .setName('criar-produto')
        .setDescription('Cria um novo produto para venda (Apenas Admins)')
        .addStringOption(option =>
            option.setName('nome')
                .setDescription('Nome do produto')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('preco')
                .setDescription('Preço do produto (ex: 10.00)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('descricao')
                .setDescription('Descrição detalhada do produto')
                .setRequired(true));

    try {
        await client.application.commands.set([data]);
        console.log('Comando /criar-produto registado com sucesso!');
    } catch (error) {
        console.error('Erro ao registar comandos:', error);
    }
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

        if (interaction.isChatInputCommand() && interaction.commandName === 'criar-produto') {
            const isAdmin = interaction.member.permissions.has('Administrator') || interaction.guild.ownerId === interaction.user.id;
            if (!isAdmin) {
                return interaction.reply({ content: '❌ Apenas administradores podem usar este comando.', ephemeral: true });
            }

            const nome = interaction.options.getString('nome');
            const preco = interaction.options.getNumber('preco');
            const descricao = interaction.options.getString('descricao');

            const embed = new EmbedBuilder()
                .setTitle(`📦 ${nome}`)
                .setDescription(descricao)
                .setColor('#0099ff')
                .addFields({ name: 'Preço', value: `R$ ${preco.toFixed(2)}` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`comprar_${Date.now()}`)
                    .setLabel('Comprar Produto')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🛒')
            );

            await interaction.reply({ embeds: [embed], components: [row] });
            return;
        }

        if (interaction.isButton()) {
            const customId = interaction.customId;

            if (customId.startsWith('comprar_')) {
                const guild = interaction.guild;
                const user = interaction.user;

                const channelName = `pedido-${user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
                
                const ticketChannel = await guild.channels.create({
                    name: channelName,
                    type: 0,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: ['ViewChannel'],
                        },
                        {
                            id: user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
                        },
                        {
                            id: client.user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
                        }
                    ],
                });

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`confirm_yes_${user.id}`)
                        .setLabel('Confirmar Pagamento')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`confirm_no_${user.id}`)
                        .setLabel('Cancelar Pedido')
                        .setStyle(ButtonStyle.Danger)
                );

                await ticketChannel.send({
                    content: `Olá ${user}, obrigado pelo interesse! Por favor, efetue o pagamento e clique no botão abaixo para confirmar.`,
                    components: [confirmRow]
                });

                await supabase.from('orders').insert([
                    { user_id: user.id, channel_id: ticketChannel.id, status: 'pendente' }
                ]);

                await interaction.reply({ content: `✅ Canal de atendimento criado com sucesso: ${ticketChannel}`, ephemeral: true });
                return;
            }

            if (customId.startsWith('confirm_yes_') || customId.startsWith('confirm_no_')) {
                const isConfirm = customId.startsWith('confirm_yes_');
                const targetUserId = customId.split('_')[2];
                const newState = isConfirm ? 'aprovado' : 'cancelado';

                await interaction.update({
                    content: `Pedido alterado para **${newState.toUpperCase()}**!`,
                    components: []
                });

                const { data: order } = await supabase
                    .from('orders')
                    .select('*')
                    .eq('user_id', targetUserId)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (order && order.channel_id) {
                    const ch = await interaction.guild.channels.fetch(order.channel_id).catch(() => null);
                    if (ch) {
                        if (isConfirm) {
                            await ch.send(`✅ **Pagamento Confirmado!** Obrigado pela compra.`);
                            await ch.send(`🎁 **O teu produto/conteúdo:** \`COLOCA_O_TEU_LINK_OU_CHAVE_AQUI\``);
                            
                            await supabase
                                .from('orders')
                                .update({ status: 'entregue' })
                                .eq('user_id', targetUserId)
                                .eq('channel_id', order.channel_id);
                        } else {
                            await ch.send(`❌ **Pedido Recusado/Cancelado.**`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Erro detalhado na interação:', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Ocorreu um erro ao processar esta ação.', ephemeral: true }).catch(() => {});
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// Servidor HTTP para o Render manter a porta ativa
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Online!');
});
server.listen(process.env.PORT || 3000);
