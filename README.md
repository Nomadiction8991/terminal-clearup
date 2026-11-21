# Terminal Clearup

Plugin do Orca para Linux e Windows. A limpeza começa quando o plugin é habilitado. Para interromper, desabilite o plugin em Configurações → Plugins.

O plugin consulta o histórico local e os terminais vivos pela CLI do Orca. Fecha somente um painel por vez, quando uma única execução concluída corresponde ao workspace e painel, com o mesmo PTY quando o histórico ainda guarda esse identificador, sem mudança de saída durante um período configurável de observação (três minutos por padrão, entre 0 e 999 minutos). Valida novamente o vínculo e a instância do terminal antes de fechar. Execuções sem vínculo, terminais compartilhados por várias execuções e chats nativos ficam fora da limpeza. O histórico da execução é preservado. O plugin não muda o modo de criação de sessões.

Requer Orca 1.4.266 ou posterior no Linux ou Windows. O plugin procura a CLI na instalação que iniciou o worker e, no Linux, pode usar os lançadores locais como alternativa. O histórico estima a RAM liberada com o RSS no Linux ou o working set no Windows.

Em Configurações → Plugins → Terminal Clearup, escolha o tempo sem atividade e se deseja mostrar o contador na barra inferior.

A varredura ocorre na inicialização e a cada minuto. O tempo começa quando um terminal elegível é observado pela primeira vez e recomeça se houver nova saída ou se o plugin reiniciar. O fechamento é tentado na próxima varredura após o prazo. Passe o mouse sobre o contador para ver os terminais em observação e o horário do último fechamento.
