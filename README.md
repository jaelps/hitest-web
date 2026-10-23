# HITEST Web

Painel web em português com várias telas para monitorar módulos de máquina, sensores de ar e dosadores HITEST. **Frontend, API e persistência rodam na Vercel**: as funções serverless fornecem a API e um Redis Upstash vinculado ao projeto mantém os dispositivos, o último estado de cada equipamento e o histórico completo de atividades. Não há processo FastAPI ou servidor de aplicação para manter em outro computador.

O repositório começa sem dispositivos nem endereços privados. Cada dispositivo é configurado com uma URL HTTPS segura. O backend valida o domínio, resolve os endereços antes da conexão e bloqueia destinos não públicos; as chamadas HTTPS usam o endereço validado e não seguem redirecionamentos.

## Persistência dos dados

As configurações de dispositivos, o status mais recente (incluindo versão, uptime e horário da última resposta), o histórico de atividade e cada resultado de verificação de heartbeat (online ou offline) são salvos no Redis persistente da Vercel. **A aplicação não define prazo de expiração, não remove registros antigos e não apaga esses dados ao recarregar a página, encerrar a sessão ou fazer deploy.** Os históricos são paginados; use o botão de relógio na lista de dispositivos para consultar as leituras de um equipamento.

Os dados permanecem enquanto o banco Upstash vinculado existir e mantiver a configuração normal de persistência do provedor. Excluir/desvincular o banco ou apagá-lo no painel do provedor remove o armazenamento da aplicação; para recuperação de desastres, configure backups/snapshots no Upstash e mantenha as credenciais de recuperação seguras. A ação **Remover dispositivo** exclui o dispositivo da lista ativa intencionalmente, mas não apaga as leituras e os eventos já registrados. O histórico por dispositivo também pode ser consultado pelo ID após sua remoção.

Cada verificação periódica gera um registro permanente por dispositivo. Como a tela consulta o status a cada 15 segundos, o espaço consumido e o custo do banco crescem continuamente com o número de dispositivos e o tempo de uso; acompanhe os limites e preços do plano Upstash. Os registros permanecem disponíveis até serem removidos manualmente ou o banco ser apagado.

## Telas

- **Visão geral:** contagem, disponibilidade, estado dos equipamentos e atualização a cada 15 segundos.
- **Dispositivos:** cadastro, edição, remoção, busca, filtros por categoria e importação/exportação JSON.
- **Atividade:** histórico completo de comandos, alterações de configuração e transições de status, apresentado em páginas; o botão de relógio em cada dispositivo abre as leituras de heartbeat.
- **Configurações:** estado de autenticação, Redis e orientação de conectividade segura.

## Layout adaptável

A interface se reorganiza para telas grandes, tablets e celulares: o menu lateral vira navegação horizontal em telas estreitas, os indicadores e configurações passam para colunas menores e a tabela completa vira cartões legíveis no celular. Os dados longos também quebram linha para evitar rolagem horizontal da página.

## Executar localmente

Requisitos: Node.js 20+, npm e a CLI da Vercel (`npm install --global vercel`).

1. Instale as dependências:

   ```powershell
   npm install
   ```

2. Crie um banco Redis pelo marketplace da Vercel/Upstash e vincule-o ao projeto local:

   ```powershell
   vercel link
   vercel env pull .env.local
   ```

3. Gere um token aleatório com no mínimo 32 caracteres e adicione `HITEST_API_TOKEN` às variáveis de ambiente locais e às de desenvolvimento/produção na Vercel. O arquivo `.env.example` lista os nomes das variáveis necessárias; nunca substitua os placeholders com credenciais reais no repositório.

4. Inicie a aplicação:

   ```powershell
   vercel dev
   ```

Abra a URL local indicada pela CLI, escolha **Configurações → Configurar token** e informe o mesmo token definido no ambiente. A API, os arquivos estáticos e os caminhos `/api/*` são servidos pelo ambiente local da Vercel.

Testes unitários da validação da API:

```powershell
npm test
```

## Implantar na Vercel

1. Importe este repositório como um projeto Vercel com a raiz como diretório. O projeto usa as funções Node em `api/` e arquivos estáticos na raiz; não precisa de build frontend.
2. Crie/vincule uma instância Upstash Redis pela integração do Marketplace. A integração define `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
3. Configure `HITEST_API_TOKEN` com um segredo aleatório forte (mínimo de 32 caracteres) nas variáveis de ambiente do projeto e faça um novo deploy.
4. Abra o domínio HTTPS publicado e informe esse token na tela **Configurações**.

O token de API é validado na função serverless e fica somente na memória da sessão do navegador (`sessionStorage`); ele nunca deve ser colocado em variáveis `VITE_*`, código público, URL ou configuração versionada. A lista de dispositivos, os status mais recentes e o histórico completo ficam no Redis vinculado ao projeto, não no filesystem efêmero da função.

## Conectar equipamentos da rede

Uma função hospedada na Vercel **não consegue acessar diretamente IPs privados da LAN** onde os dispositivos estão instalados. Os comandos `/lb` são destinados ao IP local do equipamento, mas, para manter o sistema hospedado na Vercel, o tráfego precisa passar por uma URL HTTPS pública de VPN/túnel que encaminhe `/heartbeat` e `/lb` para esse IP dentro da rede autorizada. Cadastre no painel a URL HTTPS do túnel, não o IP privado diretamente. Isso exige VPN/túnel com autenticação e ACLs restritivas; prefira um túnel de saída iniciado dentro da rede a abrir portas no roteador. A URL e o certificado devem permanecer válidos a partir da rede da Vercel.

O acesso remoto não é automático só porque o navegador e os dispositivos estão na mesma rede. Uma página HTTPS também não pode usar destinos HTTP inseguros. Nunca exponha `/lb` ou o painel do dispositivo sem controles de acesso e nunca coloque tokens de túnel em URLs públicos; se o dispositivo exigir um cabeçalho de autenticação, é necessário estender o modelo da API para guardar esse segredo em ambiente seguro antes de conectá-lo.

## API

Todos os caminhos exigem `Authorization: Bearer <HITEST_API_TOKEN>`.

| Método | Caminho | Função |
| --- | --- | --- |
| `GET` | `/api/devices` | Lista a configuração. |
| `PUT` | `/api/devices` | Substitui a lista no Redis: `{"devices":[{"id":"modulo-01","category":"machine_modules","endpoint":"https://modulo.exemplo.com"}]}`. |
| `GET` | `/api/status` | Consulta `/heartbeat` dos dispositivos e retorna disponibilidade. |
| `GET` | `/api/devices/{id}/heartbeat` | Consulta um equipamento. |
| `POST` | `/api/devices/{id}/command` | Envia `/lb` para módulos de máquina e dosadores. |
| `GET` | `/api/events?offset=0&limit=50` | Lê uma página do histórico permanente de eventos. |
| `GET` | `/api/devices/{id}/history?offset=0&limit=25` | Lê uma página de todas as verificações permanentes do dispositivo, inclusive após sua remoção. |

Categorias: `machine_modules`, `air_sensors`, `online_dosers`. O endpoint de um dispositivo precisa ser HTTPS em domínio público; endereços IP literais, hosts internos, respostas DNS privadas e redirecionamentos são rejeitados. O túnel encaminha a chamada ao IP configurado na rede local. As consultas têm limite de tempo e tamanho de resposta.
