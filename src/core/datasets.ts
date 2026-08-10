/**
 * Que conjuntos de dados o mercado tem.
 *
 * Mora aqui pelo mesmo motivo de `core/servers.ts`: `dataset` é vocabulário que o banco,
 * a API e o agendador falam o tempo todo — um snapshot é de um dataset, uma coleta é de um
 * dataset. Nasceu dentro do coletor, derivado da menor busca que cada endpoint aceita, e
 * ficou preso lá; o coletor é um componente à parte agora, e o resto do serviço não pode
 * depender dele para saber o nome das próprias coisas.
 */

/**
 * - `trading`: um anúncio por linha — quem está vendendo, por quanto, em que loja.
 * - `market-price`: um agregado por item, publicado pelo site.
 */
export const DATASETS = ["trading", "market-price"] as const;
export type Dataset = (typeof DATASETS)[number];
