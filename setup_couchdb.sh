#!/usr/bin/env bash

# ==========================================
# Script de Configuração de Usuário do CouchDB
# ==========================================

# 1. Variáveis exportadas automaticamente
set -a

# 2. Carrega o arquivo .env (ajuste o caminho se necessário)
source .env

# 3. Desativa a exportação automática
set +a

# ==========================================
# Função para Verificar Conexão
# ==========================================
check_couchdb_connection() {
    echo "Verificando conexão com o CouchDB..."

    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -u "$COUCH_ADMIN_USER:$COUCH_ADMIN_PASS" \
        --connect-timeout 10 \
        "$COUCH_HOST/_users")

    if [ "$HTTP_CODE" = "200" ]; then
        echo "Conexão OK."
        return 0
    else
        echo "Falha na conexão. HTTP_CODE=$HTTP_CODE"
        return 1
    fi
}

# ==========================================
# Função para Criar Usuário do Plugin
# ==========================================
create_plugin_user() {
    echo "Criando usuário plugin: $COUCH_PLUGIN_USER..."
    curl -u "$COUCH_ADMIN_USER":"$COUCH_ADMIN_PASS" \
         -X PUT "$COUCH_HOST/_users/org.couchdb.user:$COUCH_PLUGIN_USER" \
         -H "Content-Type: application/json" \
         -d "{
          \"name\": \"$COUCH_PLUGIN_USER\",
          \"type\": \"user\",
          \"roles\": [\"$COUCH_PLUGIN_ROLE\"],
          \"password\": \"$COUCH_PLUGIN_PASS\"
        }" || echo "Falha ao criar usuário"
    echo ""
}

# ==========================================
# Função para Configurar Segurança do DB
# ==========================================
set_db_security() {
    echo "Configurando segurança do banco de dados: $COUCH_DB..."
    curl -u "$COUCH_ADMIN_USER":"$COUCH_ADMIN_PASS" \
         -X PUT "$COUCH_HOST/$COUCH_DB/_security" \
         -H "Content-Type: application/json" \
         -d "{
          \"admins\": {
            \"names\": [],
            \"roles\": []
          },
          \"members\": {
            \"names\": [],
            \"roles\": [\"$COUCH_PLUGIN_ROLE\"]
          }
        }" || echo "Falha ao configurar segurança"
    echo ""
}

# ==========================================
# Execução Principal
# ==========================================
main() {
    check_couchdb_connection

    if [ $? -eq 0 ]; then
        create_plugin_user
        set_db_security
        echo "Configuração concluída com sucesso!"
    else
        echo "Erro: Não foi possível conectar ao CouchDB."
        exit 1
    fi
}

# Executa a função principal
main
