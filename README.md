# HITEST Web

Painel web em português com várias telas para monitorar módulos de máquina, sensores de ar e dosadores HITEST. **Frontend, API e persistência rodam na Vercel**: as funções serverless fornecem a API e um Redis Upstash vinculado ao projeto mantém os dispositivos, o último estado de cada equipamento e o histórico completo de atividades. Não há processo FastAPI ou servidor de aplicação para manter em outro computador.

O repositório começa sem dispositivos nem endereços de rede. Não é necessário instalar ou manter programas nos equipamentos. Módulos, sensores e dosadores são consultados pela API Vercel através de endpoints públicos. Para ar-condicionado, o painel guarda o IP cadastrado e abre no navegador `http://<IP>/airon1`; o comando segue diretamente pela rede conectada ao computador/celular, sem passar pela Vercel.

## Persistência dos dados

As configurações de dispositivos, o status mais recente (incluindo versão, uptime e horário da última resposta), o histórico de atividade e cada resultado de verificação de heartbeat (online ou offline) são salvos no Redis persistente da Vercel. **A aplicação não define prazo de expiração, não remove registros antigos e não apaga esses dados ao recarregar a página, encerrar a sessão ou fazer deploy.** Os históricos são paginados; use o botão de relógio na lista de dispositivos para consultar as leituras de um equipamento.

Os dados permanecem enquanto o banco Upstash vinculado existir e mantiver a configuração normal de persistência do provedor. Excluir/desvincular o banco ou apagá-lo no painel do provedor remove o armazenamento da aplicação; para recuperação de desastres, configure backups/snapshots no Upstash e mantenha as credenciais de recuperação seguras. A ação **Remover dispositivo** exclui o dispositivo da lista ativa intencionalmente, mas não apaga as leituras e os eventos já registrados. O histórico por dispositivo também pode ser consultado pelo ID após sua remoção.

Cada verificação periódica dos dispositivos remotos gera um registro permanente. Como a tela consulta o status a cada 15 segundos, o espaço consumido e o custo do banco crescem continuamente com o número de dispositivos monitorados e o tempo de uso; acompanhe os limites e preços do plano Upstash. Ar-condicionados locais não geram snapshots de heartbeat. Os registros permanecem disponíveis até serem removidos manualmente ou o banco ser apagado.

## Telas

- **Visão geral:** contagem, disponibilidade, estado dos equipamentos e atualização a cada 15 segundos.
- **Dispositivos:** cadastro, edição, remoção, busca, filtros por categoria e importação/exportação JSON. Equipamentos de ar-condicionado usam um IP IPv4; os demais continuam com endpoints HTTPS públicos.
- **Atividade:** histórico completo de comandos, alterações de configuração e transições de status, apresentado em páginas; o botão de relógio em cada dispositivo abre as leituras de heartbeat.
- **Configurações:** estado de autenticação, Redis e orientação de conectividade segura.
- **Comando local:** depois da confirmação, o botão do ar-condicionado abre `GET http://<IP>/airon1` em uma nova aba. Não usa `fetch`, então não depende de CORS nem de instalar um programa local.

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

Para controlar um ar-condicionado sem instalar nada, cadastre-o como **Ar-condicionado** e informe o IPv4 do equipamento. Use o celular ou computador na mesma rede local. O navegador abre o endereço HTTP do dispositivo em outra aba, enviando `GET /airon1`; a resposta do próprio equipamento aparece nessa aba. A Vercel só salva o IP no Redis e registra que a ação foi aberta, mas não envia o comando nem tenta monitorar esse IP.

Navegação direta não usa `fetch`, então não depende de CORS. Como o dispositivo usa HTTP, o comando e a resposta não são criptografados; use somente em uma rede confiável. O navegador pode exibir um aviso de segurança ou, por política local, impedir a navegação de uma página HTTPS para um endereço HTTP. Nesses casos, não há um modo browser-only garantido para contornar a proteção: seria necessário HTTPS no dispositivo ou um app/gateway que faça a chamada local. IPs dinâmicos precisam ser atualizados no cadastro.

Módulos, sensores e dosadores continuam sendo monitorados pela rota serverless. Eles exigem domínio HTTPS público ou IP público; a Vercel não consegue acessar diretamente endereços privados da rede local.

## API

Todos os caminhos exigem `Authorization: Bearer <HITEST_API_TOKEN>`.

| Método | Caminho | Função |
| --- | --- | --- |
| `GET` | `/api/devices` | Lista a configuração. |
| `PUT` | `/api/devices` | Substitui a lista no Redis. Dispositivos remotos usam `endpoint`; ar-condicionado local usa `{"id":"ar-01","category":"air_conditioners","ip":"IPV4-DO-EQUIPAMENTO"}`. |
| `GET` | `/api/status` | Consulta `/heartbeat` dos dispositivos remotos e marca ar-condicionados como controle local. |
| `GET` | `/api/devices/{id}/heartbeat` | Consulta um dispositivo remoto. Ar-condicionado é acessado diretamente no navegador. |
| `POST` | `/api/devices/{id}/command` | Envia `/lb` para módulos de máquina e dosadores. |
| `POST` | `/api/devices/{id}/local-command` | Registra a abertura do comando local `/airon1`; o navegador acessa diretamente o dispositivo. |
| `GET` | `/api/events?offset=0&limit=50` | Lê uma página do histórico permanente de eventos. |
| `GET` | `/api/devices/{id}/history?offset=0&limit=25` | Lê uma página de todas as verificações permanentes do dispositivo, inclusive após sua remoção. |

Categorias: `machine_modules`, `air_sensors`, `online_dosers`, `air_conditioners`. Ar-condicionado salva um IPv4 local ou público, mas o backend nunca faz requisição a esse IP; o navegador abre a rota fixa `/airon1`. As outras categorias continuam protegidas contra destinos não públicos e aceitam domínios HTTPS ou IPs públicos nas portas padrão.
