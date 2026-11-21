# Terminal Clearup

![Terminal Clearup para Orca. Menos abas, menos RAM.](images/cover.webp)

**Feche automaticamente terminais de automações concluídas no Orca.** Acompanhe as abas fechadas e a estimativa de RAM liberada no dia, com histórico dentro do aplicativo.

[Instalação](#instalação) · [Como funciona](#como-funciona) · [Configurações](#configurações) · [Compatibilidade](#compatibilidade)

## Instalação

No Orca, abra **Configurações → Plugins** e procure por **Terminal Clearup** se o plugin estiver disponível no seu catálogo comunitário. Também é possível instalar diretamente do GitHub:

```sh
orca plugin install Nomadiction8991/terminal-clearup@v0.3.18
```

Revise o acesso solicitado pelo Orca e habilite o plugin. A limpeza de automações vem ligada por padrão.

## Como funciona

1. Na inicialização e a cada minuto, o plugin cruza os terminais abertos com o histórico local de automações. Isso inclui terminais que já estavam abertos antes da instalação.
2. Um terminal entra na limpeza quando tem vínculo único com uma execução concluída. A espera começa na primeira detecção e reinicia se o terminal gerar nova saída. Antes do fechamento, o plugin confere novamente a identidade da sessão e sua atividade.
3. O contador da barra inferior mostra as abas fechadas hoje e a estimativa de RAM liberada quando há medição. O painel **Histórico do Terminal Clearup** guarda os 50 fechamentos mais recentes.

Quando o Orca perde o acompanhamento de uma execução, há uma regra separada. Ela exige pelo menos três minutos sem nova saída e confirmação de ociosidade pelo Orca. Terminais sem vínculo identificado com automações podem ser observados, mas ficam fora do fechamento automático.

![Histórico de fechamentos, configurações, logs e totais do dia no Orca.](images/dashboard.webp)

## Configurações

Abra **Configurações → Plugins → Terminal Clearup**.

| Opção | Padrão | Efeito |
|---|---|---|
| Limpar automações concluídas | Ligado | Fecha o terminal vinculado à execução concluída. |
| Tempo sem atividade das automações | 3 min | Aceita de 0 a 999. Com 0, tenta fechar na primeira varredura elegível. |
| Limpar automações que perderam o acompanhamento | Ligado | Exige confirmação de ociosidade e pelo menos 3 minutos sem nova saída. |
| Observar outras sessões do Orca | Desligado | Mostra sessões sem vínculo identificado no resumo, sem fechá-las. |
| Observar outras sessões após | 15 min | Use 0 para mostrá-las já na primeira varredura. |
| Mostrar contador na barra inferior | Ligado | Mostra o total de hoje. Passe o mouse para ver quantos fechamentos tiveram medição. |

## Compatibilidade

- **Orca 1.4.266 ou posterior.** Esse é o mínimo declarado no manifesto. O plugin aceita versões posteriores sem limite máximo, desde que mantenham os comandos e os formatos de resposta usados pelo plugin. As versões futuras não foram verificadas.
- **Linux e Windows.** A limpeza foi exercitada em uso real no Linux. O suporte ao Windows foi implementado na versão 0.3.18 e ainda precisa de validação de ponta a ponta em uma máquina Windows.
- **Sessões locais com terminal.** A limpeza depende do vínculo registrado entre a automação e o painel. Conversas nativas sem terminal ficam fora dela.

## Medição de RAM e acesso

O plugin usa a métrica por sessão do próprio Orca, RSS no Linux e *working set* no Windows. O histórico mostra uma estimativa quando há medição e o Orca confirma que encerrou o processo. O valor pode diferir do aumento de RAM disponível no sistema.

O Orca mostra um aviso de acesso total porque o plugin roda como `trusted-worker` para chamar a CLI local. O histórico e o contador são guardados no armazenamento do próprio plugin.

## Desenvolvimento

Para verificar o manifesto e executar os testes simulados:

```sh
orca plugin validate .
node --test tests/cleanup.test.mjs
```
