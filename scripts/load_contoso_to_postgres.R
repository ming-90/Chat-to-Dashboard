#!/usr/bin/env Rscript

project_root <- normalizePath(getwd(), mustWork = TRUE)
project_library <- file.path(project_root, ".r-lib")
env_file <- file.path(project_root, ".env")

load_dotenv <- function(path) {
  if (!file.exists(path)) {
    return(invisible(FALSE))
  }

  lines <- readLines(path, warn = FALSE)

  for (line in lines) {
    trimmed <- trimws(line)

    if (identical(trimmed, "") || startsWith(trimmed, "#") || !grepl("=", trimmed, fixed = TRUE)) {
      next
    }

    key <- trimws(sub("=.*$", "", trimmed))
    value <- trimws(sub("^[^=]*=", "", trimmed))
    value <- sub("^['\"]", "", sub("['\"]$", "", value))

    if (identical(Sys.getenv(key, unset = ""), "")) {
      do.call(Sys.setenv, stats::setNames(list(value), key))
    }
  }

  invisible(TRUE)
}

load_dotenv(env_file)

if (!dir.exists(project_library)) {
  dir.create(project_library, recursive = TRUE)
}

.libPaths(c(project_library, .libPaths()))

required_packages <- c("contoso", "DBI", "RPostgres", "duckdb", "dbplyr")
missing_packages <- required_packages[!vapply(required_packages, requireNamespace, logical(1), quietly = TRUE)]

if (length(missing_packages) > 0) {
  message("Installing missing R packages into ", project_library, ": ", paste(missing_packages, collapse = ", "))
  install.packages(missing_packages, lib = project_library, repos = "https://cloud.r-project.org")
}

suppressPackageStartupMessages({
  library(contoso)
  library(DBI)
  library(RPostgres)
})

env <- function(name, default = "") {
  value <- Sys.getenv(name, unset = default)
  if (identical(value, "")) default else value
}

contoso_size <- env("CONTOSO_SIZE", "small")
target_schema <- env("PGSCHEMA", "public")
overwrite <- tolower(env("CONTOSO_OVERWRITE", "true")) %in% c("1", "true", "yes", "y")

tables <- c(
  "calendar",
  "customer",
  "product",
  "store",
  "fx",
  "orders",
  "orderrows",
  "sales"
)

connect_postgres <- function() {
  database_url <- env("DATABASE_URL")
  has_pg_settings <- !identical(env("PGDATABASE"), "") && !identical(env("PGUSER"), "")

  if (!identical(database_url, "") && !has_pg_settings) {
    return(DBI::dbConnect(RPostgres::Postgres(), dbname = database_url))
  }

  required_env <- c("PGDATABASE", "PGUSER")
  missing_env <- required_env[Sys.getenv(required_env, unset = "") == ""]

  if (length(missing_env) > 0) {
    stop(
      "Missing PostgreSQL connection settings. Set DATABASE_URL or ",
      paste(required_env, collapse = ", "),
      call. = FALSE
    )
  }

  DBI::dbConnect(
    RPostgres::Postgres(),
    dbname = env("PGDATABASE"),
    host = env("PGHOST", "localhost"),
    port = as.integer(env("PGPORT", "5432")),
    user = env("PGUSER"),
    password = env("PGPASSWORD")
  )
}

quote_ident <- function(value) {
  paste0('"', gsub('"', '""', value, fixed = TRUE), '"')
}

copy_table <- function(source, target, table_name) {
  message("Loading table: ", target_schema, ".", table_name)

  data <- DBI::dbReadTable(source$con, table_name)

  DBI::dbWriteTable(
    target,
    DBI::Id(schema = target_schema, table = table_name),
    data,
    overwrite = overwrite,
    append = !overwrite,
    row.names = FALSE
  )

  row_count <- DBI::dbGetQuery(
    target,
    paste0(
      "SELECT COUNT(*) AS n FROM ",
      quote_ident(target_schema),
      ".",
      quote_ident(table_name)
    )
  )$n[[1]]

  message("Loaded ", row_count, " rows into ", target_schema, ".", table_name)
}

message("Creating Contoso DuckDB dataset. size=", contoso_size)
contoso_db <- contoso::create_contoso_duckdb(size = contoso_size)

message("Connecting to PostgreSQL")
pg <- connect_postgres()

tryCatch(
  {
    DBI::dbExecute(pg, paste0("CREATE SCHEMA IF NOT EXISTS ", quote_ident(target_schema)))

    for (table_name in tables) {
      copy_table(contoso_db, pg, table_name)
    }

    message("Done. Imported Contoso tables into PostgreSQL schema: ", target_schema)
  },
  finally = {
    DBI::dbDisconnect(pg)
    DBI::dbDisconnect(contoso_db$con, shutdown = TRUE)
  }
)
