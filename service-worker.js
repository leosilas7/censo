const CACHE_NAME = 'indexeddb-pwa-cache-v1'; // Nome do cache
const urlsToCache = [
  '/',
  '/index.html',
  '/brasao_prefeitura.png',
  '/manifest.json'
  // Adicione aqui outros assets se houver CSS/JS externos (ex: '/css/style.css', '/js/script.js')
];

// Instalação do Service Worker: Cacheia os assets
self.addEventListener('install', (event) => {
  console.log('Service Worker: Evento de install.');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Cacheando assets da App Shell:', urlsToCache);
        return cache.addAll(urlsToCache.map(url => new Request(url, { credentials: 'omit' })));
      })
      .then(() => self.skipWaiting())
      .catch(err => console.error('Service Worker: Falha durante o install:', err))
  );
});

// Ativação do Service Worker: Remove caches antigos
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Evento de activate.');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Removendo cache antigo', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
      .then(() => self.clients.claim())
      .catch(err => console.error('Service Worker: Falha durante o activate:', err))
  );
});

// Interceptação de requisições
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // Verifica se a requisição é para um recurso local (mesma origem) que pode ser cachead
  const isLocalAsset = requestUrl.origin === self.location.origin && urlsToCache.includes(requestUrl.pathname);

  // Estratégia: Cache-First para assets estáticos e GETs locais (opcionalmente)
  if (isLocalAsset || (requestUrl.origin === self.location.origin && event.request.method === 'GET')) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          if (response) {
            console.log('Service Worker: Servindo do cache:', event.request.url);
            return response;
          }
          console.log('Service Worker: Buscando da rede (e caching se GET):', event.request.url);
          return fetch(event.request).then(networkResponse => {
            const responseToCache = networkResponse.clone();
            if (networkResponse.status === 200 && event.request.method === 'GET' && requestUrl.origin === self.location.origin) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseToCache);
              });
            }
            return networkResponse;
          })
            .catch(error => {
              console.error('Service Worker: Fetch failed for', event.request.url, error);
              // if (isLocalAsset) return caches.match('/offline.html'); // Exemplo de fallback
              throw error;
            });
        })
    );
  } else {
    console.log('Service Worker: Passando requisição para a rede:', event.request.method, event.request.url);
    return fetch(event.request);
  }
});

// Event listener para o evento 'sync' do Background Sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-responses') {
    console.log('Service Worker: Evento de sync recebido para tag', event.tag);
    event.waitUntil(syncPendingData());
  }
});

// Função para sincronizar os dados pendentes
async function syncPendingData() {
  console.log('syncPendingData: >>> Iniciando tentativa de sincronização...');
  let db;
  let openRequest = self.indexedDB.open("BancoRespostasTiposSexo", 2);

  try {
    db = await new Promise((resolve, reject) => {
      openRequest.onsuccess = (event) => {
        console.log('syncPendingData: Banco de dados aberto com sucesso.');
        resolve(event.target.result);
      };
      openRequest.onerror = (event) => {
        console.error('syncPendingData: --- Erro ao abrir o banco de dados para sync', event.target.error);
        reject(event.target.error);
      };
    });
  } catch (dbError) {
    console.error('syncPendingData: !!! Falha ao abrir banco de dados, abortando sync.', dbError);
    throw dbError; // Lança erro para o SyncManager re-tentar
  }


  // Use uma transação única para ler, enviar e atualizar/deletar
  // 'readwrite' permite ler E escrever/deletar em ambas as lojas
  // A transação só será COMMITADA se TODAS as operações dentro dela forem bem sucedidas e o Promise do waitUntil resolver
  const transaction = db.transaction(["pendingSync", "tiposSexos"], "readwrite");
  const pendingStore = transaction.objectStore("pendingSync");
  const tiposSexosStore = transaction.objectStore("tiposSexos");

  let pendingItems;
  try {
    pendingItems = await new Promise((resolve, reject) => {
      const getAllRequest = pendingStore.getAll();
      getAllRequest.onsuccess = () => {
        console.log('syncPendingData: Itens pendentes buscados com sucesso.');
        resolve(getAllRequest.result);
      };
      getAllRequest.onerror = (event) => {
        console.error('syncPendingData: --- Erro ao buscar itens pendentes do IndexedDB', event.target.error);
        reject(event.target.error);
      };
    });
  } catch (getError) {
    console.error('syncPendingData: !!! Falha ao buscar itens pendentes, abortando sync.', getError);
    throw getError; // Lança erro para o SyncManager re-tentar
  }


  console.log('syncPendingData: Encontrados', pendingItems.length, 'itens pendentes para sincronizar.');

  if (pendingItems.length === 0) {
    console.log('syncPendingData: Nenhuns itens pendentes para sincronizar. <<< Sincronização concluída.');
    return; // Retorna a Promise resolvida implicitamente
  }

  // Crie um array de Promises, uma para cada item a ser sincronizado
  // Cada Promise AGORA vai esperar a deleção do DB antes de considerar o item sincronizado
  const syncPromises = pendingItems.map(async (item) => {
    console.log('syncPendingData: Processando item syncId:', item.id, 'localId:', item.localId);
    try {
      console.log('syncPendingData: Tentando fetch para item syncId:', item.id, 'localId:', item.localId, 'URL:', item.apiEndpoint);
      console.log('syncPendingData: Dados a enviar para item syncId:', item.id, ':', item.data);

      const response = await fetch(item.apiEndpoint, {
        method: item.method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*'
        },
        body: JSON.stringify(item.data)
      });

      if (response.ok) {
        console.log('syncPendingData: Fetch bem sucedido para item syncId:', item.id, '. Status:', response.status);
        const apiData = await response.json();
        console.log('syncPendingData: Resposta da API para item syncId:', item.id, ':', apiData);

        // --- ATUALIZA O REGISTRO LOCAL COM O ID DA API ---
        try {
          console.log('syncPendingData: Tentando buscar item local para atualizar. localId:', item.localId);
          const localItemToUpdate = await new Promise((resolveLocalGet, rejectLocalGet) => {
            const localItemRequest = tiposSexosStore.get(item.localId);
            localItemRequest.onsuccess = (event) => resolveLocalGet(event.target.result);
            localItemRequest.onerror = (event) => rejectLocalGet(event.target.error);
          });


          if (localItemToUpdate) {
            const oldApiId = localItemToUpdate.tipoSexoId; // O valor antes da atualização (0 ou null)
            localItemToUpdate.tipoSexoId = apiData.tipoSexoId;
            console.log('syncPendingData: Item local encontrado (localId:', item.localId, '). Atualizando tipoSexoId de', oldApiId, 'para', apiData.tipoSexoId);

            await new Promise((resolvePut, rejectPut) => {
              const putRequest = tiposSexosStore.put(localItemToUpdate);
              putRequest.onsuccess = () => {
                console.log('syncPendingData: Item local (localId:', item.localId, ') atualizado com sucesso no DB.');
                // Enviar mensagem para a página principal para atualizar a UI
                self.clients.matchAll().then(clients => {
                  clients.forEach(client => client.postMessage({ type: 'sync-complete', localId: item.localId, apiId: apiData.tipoSexoId }));
                });
                resolvePut();
              };
              putRequest.onerror = (event) => {
                console.error('syncPendingData: --- Erro ao atualizar item local (localId:', item.localId, ') no DB:', event.target.error);
                rejectPut(event.target.error);
              };
            });

          } else {
            console.warn('syncPendingData: !!! Item local (localId:', item.localId, ') NÃO ENCONTRADO para atualização.');
            // Item não encontrado localmente, mas foi sincronizado na API.
            // Decide se deleta da fila mesmo assim ou re-tenta.
            // Para evitar duplicação na API, geralmente deletamos da fila.
            console.log('syncPendingData: Item local não encontrado, mas API sync ok. Removendo item syncId:', item.id, 'da fila.');
          }
        } catch (localUpdateError) {
          console.error('syncPendingData: --- Erro durante a fase de busca/atualização local para item syncId:', item.id, localUpdateError);
          // Um erro inesperado durante a atualização local. Lançamos para re-tentar TUDO.
          throw localUpdateError;
        }
        // --- FIM ATUALIZAÇÃO LOCAL ---

        // --- AGUARDA A DELEÇÃO DA FILA ANTES DE CONSIDERAR O ITEM SINCRONIZADO ---
        console.log('syncPendingData: Tentando remover item syncId:', item.id, 'localId:', item.localId, 'da fila pendingSync.');
        return new Promise((resolveDelete, rejectDelete) => {
          const deleteRequest = pendingStore.delete(item.id);
          deleteRequest.onsuccess = () => {
            console.log('syncPendingData: Item syncId:', item.id, 'removido com sucesso da fila.');
            resolveDelete(); // RESOLVE a promise deste item no map()
          };
          deleteRequest.onerror = (event) => {
            console.error('syncPendingData: --- Erro ao remover item syncId:', item.id, 'da fila pendingSync:', event.target.error);
            // A remoção falhou. Lança erro para re-tentar a sync deste item.
            rejectDelete(event.target.error);
          };
        });
        // --- FIM AGUARDA DELEÇÃO ---

      } else {
        const errorText = await response.text();
        console.warn(`syncPendingData: --- Fetch FALHOU (resposta não OK) para item syncId ${item.id}: Status ${response.status}. Resposta: ${errorText}.`);
        // Lança um erro para que o SyncManager re-agende (com backoff)
        throw new Error(`API Sync Failed: Status ${response.status} for syncId ${item.id}`);
      }
    } catch (error) {
      console.error('syncPendingData: !!! Erro GERAL durante processamento do item syncId:', item.id, error, ':', error);
      // Erro de rede no fetch, erro no parsing da resposta, ou erro lançado acima.
      // Lança o erro para que o SyncManager re-agende o sync.
      throw error;
    }
    // O Promise deste item no map() só resolve se a deleção da fila for bem sucedida.
  });

  // Espera que todas as Promises de sincronização de itens terminem (incluindo a espera pela deleção)
  try {
    await Promise.all(syncPromises);
    console.log('syncPendingData: +++ Processamento de TODOS os itens de sync concluído SEM ERROS LANCADOS. A transação IndexedDB será commitada. <<<');
    // A transação é auto-commitada se não houver erros não tratados/não pegos em promises internas.
  } catch (error) {
    console.error('syncPendingData: --- Algumas sincronizações falharam ou encontraram erros. A re-tentativa será agendada.', error);
    // Se qualquer Promise dentro de syncPromises rejeitar, o Promise.all rejeita,
    // e o event.waitUntil rejeita, sinalizando ao navegador para re-tentar a sync.
    throw error; // Re-lança o erro para o SyncManager
  }
  console.log('syncPendingData: <<< Fim da função syncPendingData.');
}






























// // Event listener para o evento 'sync' do Background Sync
// self.addEventListener('sync', (event) => {
//     if (event.tag === 'sync-responses') {
//         console.log('Service Worker: Evento de sync recebido para tag', event.tag);
//         event.waitUntil(syncPendingData()); 
//     }
// });

// // Função para sincronizar os dados pendentes
// async function syncPendingData() {
//     console.log('Service Worker: Tentando sincronizar dados pendentes...');
//     let db;
//     let openRequest = self.indexedDB.open("BancoRespostasTiposSexo", 2); 

//     db = await new Promise((resolve, reject) => {
//         openRequest.onsuccess = (event) => resolve(event.target.result);
//         openRequest.onerror = (event) => reject(event.target.error);
//     });

//     const transaction = db.transaction(["pendingSync", "tiposSexos"], "readwrite"); 
//     const pendingStore = transaction.objectStore("pendingSync");
//     const tiposSexosStore = transaction.objectStore("tiposSexos");

//     const pendingItems = await new Promise((resolve, reject) => {
//         const getAllRequest = pendingStore.getAll();
//         getAllRequest.onsuccess = () => resolve(getAllRequest.result);
//         getAllRequest.onerror = (event) => reject(event.target.error);
//     });

//     console.log('Service Worker: Encontrados', pendingItems.length, 'itens pendentes para sincronizar.');

//     if (pendingItems.length === 0) {
//         console.log('Service Worker: Nenhuns itens pendentes para sincronizar.');
//         return;
//     }

//     const syncPromises = pendingItems.map(async (item) => {
//         try {
//             console.log('Service Worker: Sincronizando item local ID:', item.localId, 'para', item.apiEndpoint);
//             console.log('Service Worker: Dados a enviar:', item.data);
            
//             const response = await fetch(item.apiEndpoint, {
//                 method: item.method,
//                 headers: {
//                     'Content-Type': 'application/json',
//                     'Accept': '*/*' // <-- Adicionado conforme o curl
//                 },
//                 body: JSON.stringify(item.data)
//             });

//             if (response.ok) {
//                 const apiData = await response.json();
//                 console.log('Service Worker: Item local ID', item.localId, 'sincronizado com sucesso. API retornou:', apiData);

//                 try {
//                     const localItemRequest = tiposSexosStore.get(item.localId); 

//                     await new Promise((resolveUpdate, rejectUpdate) => {
//                         localItemRequest.onsuccess = (event) => {
//                             const itemToUpdate = event.target.result;
//                             if (itemToUpdate) {
//                                 itemToUpdate.tipoSexoId = apiData.tipoSexoId; 
                                
//                                 const putRequest = tiposSexosStore.put(itemToUpdate); 
//                                 putRequest.onsuccess = () => {
//                                     console.log('Service Worker: Registro local (ID:', item.localId, ') atualizado com API ID:', apiData.tipoSexoId);
//                                      self.clients.matchAll().then(clients => {
//                                          clients.forEach(client => client.postMessage({ type: 'sync-complete', localId: item.localId, apiId: apiData.tipoSexoId }));
//                                      });
//                                     resolveUpdate(); 
//                                 };
//                                 putRequest.onerror = (e) => {
//                                     console.error('Service Worker: Erro ao atualizar registro local:', e);
//                                     resolveUpdate(); 
//                                 };
//                             } else {
//                                 console.warn('Service Worker: Registro local (ID:', item.localId, ') não encontrado para atualização após sync bem sucedida.');
//                                 resolveUpdate(); 
//                             }
//                         };
//                         localItemRequest.onerror = (e) => {
//                              console.error('Service Worker: Erro ao buscar registro local para atualização:', e);
//                              resolveUpdate(); 
//                         };
//                     });
//                 } catch (updateError) {
//                      console.error('Service Worker: Erro inesperado durante a fase de atualização local após sync da API:', updateError);
//                 }

//                 const deleteRequest = pendingStore.delete(item.id); 
//                 deleteRequest.onsuccess = () => console.log('Service Worker: Item removido da fila de sync:', item.id);
//                 deleteRequest.onerror = (e) => console.error('Service Worker: Erro ao remover item da fila de sync:', item.id, e);

//             } else {
//                  const errorText = await response.text();
//                  console.warn(`Service Worker: Falha na resposta da API para item local ID ${item.localId}: Status ${response.status}. ${errorText}.`);
//                  throw new Error(`API Sync Failed: Status ${response.status} for localId ${item.localId}`); 
//             }
//         } catch (error) {
//             console.error('Service Worker: Erro ao enviar item local ID', item.localId, 'durante sync:', error);
//             throw error; 
//         }
//     });

//     try {
//         await Promise.all(syncPromises);
//         console.log('Service Worker: Processamento de todos os itens de sync concluído com sucesso.');
//     } catch (error) {
//         console.error('Service Worker: Algumas sincronizações falharam. A re-tentativa será agendada.', error);
//         throw error;
//     }
// }