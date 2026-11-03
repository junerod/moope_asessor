"use client";

import { useEffect, useMemo, useState } from "react";
import type { VisualBoardPayload, VisualFicha, VisualTable } from "@/domain/visual-board";
import "@/app/v/visual.css";

const DONUT_COLORS = ["#26c6da", "#1565c0", "#fb8c00", "#43a047", "#8e24aa", "#546e7a"];

function maxOf(bars: { value: number }[]) {
  return Math.max(...bars.map((b) => b.value), 1);
}

function Donut({ parts }: { parts: { label: string; value: number; display: string }[] }) {
  const live = parts.filter((p) => p.value > 0);
  const total = live.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  const stops = live
    .map((p) => {
      const start = (acc / total) * 100;
      acc += p.value;
      const end = (acc / total) * 100;
      const color = DONUT_COLORS[parts.indexOf(p) % DONUT_COLORS.length];
      return `${color} ${start}% ${end}%`;
    })
    .join(", ");
  return (
    <div className="vb-donut-row">
      <div className="vb-donut" style={{ background: `conic-gradient(${stops})` }} />
      <ul className="vb-legend">
        {parts.map((p, i) => (
          <li key={p.label}>
            <i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            <span>
              {p.label}
              <strong>{p.display}</strong>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bars({
  title,
  bars,
  money,
}: {
  title: string;
  bars: { label: string; value: number; display: string }[];
  money?: boolean;
}) {
  const max = maxOf(bars);
  return (
    <section className="vb-card" aria-label={title}>
      <h2>{title}</h2>
      <ul className="vb-bars">
        {bars.map((b) => (
          <li key={b.label}>
            <span className="vb-bar-label">
              <em>{b.label}</em>
              <strong>{b.display}</strong>
            </span>
            <div className={money ? "vb-track vb-track-money" : "vb-track"}>
              <i style={{ width: `${Math.max(6, Math.round((b.value / max) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FICHA_LINHAS: { key: string; label: string }[] = [
  { key: "documento", label: "Documento" },
  { key: "email", label: "E-mail" },
  { key: "telefone", label: "WhatsApp" },
  { key: "placas", label: "Placas" },
  { key: "ultimo", label: "Último repasse" },
  { key: "data", label: "Data" },
  { key: "ano", label: "Repasses no ano" },
  { key: "contratos", label: "Contratos" },
  { key: "faturas", label: "Faturas" },
  { key: "parcela", label: "Parcela do contrato" },
  { key: "deve", label: "Quanto deve" },
  { key: "proxima", label: "Próxima parcela" },
  { key: "semana", label: "A receber na semana" },
  { key: "mes", label: "A receber no mês" },
  { key: "pago", label: "Pago no mês" },
  { key: "modelo", label: "Veículo" },
  { key: "locatario", label: "Locatário" },
  { key: "motorista", label: "Motorista" },
  { key: "local", label: "Última localização" },
  { key: "situacao", label: "Situação" },
  { key: "partes", label: "Partes" },
  { key: "area", label: "Área" },
  { key: "filial", label: "Filial" },
];

function chipTone(situacao: string) {
  const s = situacao.toLowerCase();
  if (s.includes("atras") || s.includes("aberto") || s.includes("manuten") || s.includes("oficina")) {
    return "warn";
  }
  if (s.includes("dispon") || s.includes("sem ")) return "muted";
  return "ok";
}

function noun(title: string | undefined, n: number, kind?: string) {
  if (kind === "processo" || /processo/i.test(title || "")) return n === 1 ? "processo" : "processos";
  if (/prazo/i.test(title || "")) return n === 1 ? "prazo" : "prazos";
  if (/atendimento/i.test(title || "")) return n === 1 ? "atendimento" : "atendimentos";
  if (kind === "agenda" || /agenda/i.test(title || "")) {
    return n === 1 ? "compromisso" : "compromissos";
  }
  if (/ve[ií]culo/i.test(title || "")) return n === 1 ? "veículo" : "veículos";
  return n === 1 ? "pessoa" : "pessoas";
}

function painelDe(
  title: string | undefined,
  rows?: Array<{ ficha?: { papel?: string } }>
) {
  const papel = rows?.find((row) => row.ficha?.papel)?.ficha?.papel;
  if (papel === "agenda" || papel === "processo" || papel === "veiculo" || papel === "locatario") {
    return papel;
  }
  if (/agenda|atendimento/i.test(title || "")) return "agenda" as const;
  if (/processo/i.test(title || "")) return "processo" as const;
  if (/ve[ií]culo/i.test(title || "")) return "veiculo" as const;
  if (/locat/i.test(title || "")) return "locatario" as const;
  return "pessoa" as const;
}

function linhaProxima(raw: string) {
  const m = raw.match(/^(R\$\s*[\d.]+,\d{2})\s+em\s+(\d{2}\/\d{2}\/\d{4})$/);
  if (m) return `Próxima parcela em ${m[2]} — ${m[1]}`;
  if (/nenhuma/i.test(raw)) return "Nenhuma parcela a vencer";
  return raw ? `Próxima parcela ${raw}` : "";
}

type FichaAberta = { ficha: VisualFicha; related: VisualFicha[] };

function FichaSheet({
  aberta,
  podeVoltar,
  onClose,
  onBack,
  onOpen,
  onAndamento,
}: {
  aberta: FichaAberta;
  podeVoltar: boolean;
  onClose: () => void;
  onBack: () => void;
  onOpen: (ficha: VisualFicha) => void;
  onAndamento?: (numero: string) => void;
}) {
  const ficha = aberta.ficha;
  const related = aberta.related || [];
  const kicker =
    ficha.papel === "processo"
      ? "Processo"
      : ficha.papel === "veiculo"
        ? "Veículo"
        : ficha.papel === "locatario"
          ? "Locatário"
          : "";
  return (
    <div className="vb-sheet" role="dialog" aria-modal="true" aria-label={ficha.nome || "Ficha"}>
      <div className="vb-sheet-card">
        <div className="vb-sheet-actions">
          {podeVoltar ? (
            <button type="button" className="vb-sheet-close" onClick={onBack}>
              Voltar
            </button>
          ) : null}
          <button type="button" className="vb-sheet-close" onClick={onClose}>
            Fechar
          </button>
        </div>
        {kicker ? <p className="vb-kicker">{kicker}</p> : null}
        <h2>{ficha.nome || "Ficha"}</h2>
        {ficha.papel === "processo" && onAndamento && ficha.nome ? (
          <button type="button" className="vb-open" onClick={() => onAndamento(ficha.nome)}>
            Ver andamento
          </button>
        ) : null}
        <dl className="vb-ficha">
          {FICHA_LINHAS.map((line) => {
            const value = ficha[line.key];
            if (!value) return null;
            if (line.key === "locatario") {
              const pessoa = related.find((item) => item.papel === "locatario");
              return (
                <div key={line.key}>
                  <dt>{line.label}</dt>
                  <dd>
                    {pessoa ? (
                      <button type="button" className="vb-inline" onClick={() => onOpen(pessoa)}>
                        {value}
                      </button>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              );
            }
            if (line.key === "placas") {
              const carros = related.filter((item) => item.papel === "veiculo");
              const porNome = new Map(carros.map((carro) => [carro.nome.toUpperCase(), carro]));
              const partes = value.split(",").map((p) => p.trim()).filter(Boolean);
              const alguma = partes.some((parte) => porNome.has(parte.toUpperCase()));
              return (
                <div key={line.key}>
                  <dt>{line.label}</dt>
                  <dd>
                    {alguma
                      ? partes.map((parte) => {
                          const carro = porNome.get(parte.toUpperCase());
                          return carro ? (
                            <button type="button" className="vb-placa" key={parte} onClick={() => onOpen(carro)}>
                              {parte}
                            </button>
                          ) : (
                            <span key={parte}>{parte}</span>
                          );
                        })
                      : value}
                  </dd>
                </div>
              );
            }
            const href = line.key === "locatario" ? undefined : ficha[`${line.key}_href`];
            return (
              <div key={line.key}>
                <dt>{line.label}</dt>
                <dd>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {ficha.mapa ? (
          <a className="vb-dl" href={ficha.mapa} target="_blank" rel="noopener noreferrer">
            Ver no mapa
          </a>
        ) : null}
        {ficha.href ? (
          <a className="vb-dl" href={ficha.href} target="_blank" rel="noopener noreferrer">
            Abrir ficha no MOOPE Frotas
          </a>
        ) : null}
      </div>
    </div>
  );
}

type BuscaRemota = {
  token: string;
  modo: "processos" | "agenda";
  dia?: string;
  natureza?: "processual" | "administrativo" | null;
};

type AndamentoAberto = {
  titulo: string;
  loading: boolean;
  erro?: string;
  novos: Array<{ data?: string; titulo?: string; texto?: string }>;
  legado: { titulo?: string; texto?: string } | null;
};

function cardsDeBusca(
  itens: Array<Record<string, string>>,
  modo: "processos" | "agenda",
  natureza?: "processual" | "administrativo" | null
): VisualTable["rows"] {
  return itens.flatMap((item): VisualTable["rows"] => {
    if (modo === "agenda") {
      const atendimento = natureza === "administrativo";
      const titulo = String(item.titulo || (atendimento ? "Atendimento" : "Prazo"));
      const cliente = String(item.cliente || "").trim();
      const advogado = [item.advogado, item.oab ? `OAB ${item.oab}` : ""].filter(Boolean).join(" · ");
      const tipo = String(item.tipo || "");
      const nome = atendimento ? cliente || titulo : titulo;
      return [{
        cells: {
          numero: String(item.hora || ""),
          partes: nome,
          status: /^outro$/i.test(tipo) ? "" : tipo,
          area: atendimento ? advogado || String(item.local || "") : String(item.partes || item.local || ""),
          filial: String(item.filial || "Sem filial"),
          doc: atendimento ? "" : String(item.numero || ""),
        },
        ficha: {
          nome,
          papel: "agenda",
          data: String(item.hora || ""),
          partes: atendimento ? titulo : String(item.partes || "—"),
          documento: atendimento ? (item.oab ? `OAB ${item.oab}` : "") : String(item.numero || ""),
          local: String(item.local || advogado || ""),
          filial: String(item.filial || "Sem filial"),
          situacao: /^outro$/i.test(tipo) ? "" : tipo,
        },
      }];
    }
    const numero = String(item.numero || "").trim();
    const partes = [item.requerente, item.requerido].filter(Boolean).join(" × ");
    if (!numero && !partes) return [];
    return [{
      cells: {
        numero: numero || "s/n",
        partes: partes || "—",
        status: String(item.status || "—"),
        area: String(item.area || "—"),
        filial: String(item.filial || "—"),
      },
      ficha: {
        nome: numero || "s/n",
        papel: "processo",
        partes: partes || "—",
        situacao: String(item.status || "—"),
        area: String(item.area || "—"),
        filial: String(item.filial || "—"),
        data: item.movido ? `Movido em ${item.movido}` : "",
        local: "",
      },
    }];
  });
}

function PessoaCards({
  table,
  buscaRemota,
}: {
  table: VisualTable;
  buscaRemota?: BuscaRemota;
}) {
  const kind = painelDe(table.title, table.rows);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState(kind === "agenda" ? "filial" : kind === "processo" ? "numero" : "nome");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [stack, setStack] = useState<FichaAberta[]>([]);
  const aberta = stack[stack.length - 1];
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const filtered = table.rows.filter((row) => {
      if (!needle) return true;
      const bag = [
        ...table.columns.map((col) => row.cells[col.key] || ""),
        ...Object.values(row.ficha || {}),
        ...(row.related || []).flatMap((ficha) => Object.values(ficha)),
      ]
        .join(" ")
        .toLowerCase();
      const digits = needle.replace(/\D/g, "");
      if (digits.length >= 3 && bag.replace(/\D/g, "").includes(digits)) return true;
      return bag.includes(needle);
    });
    const col = table.columns.find((c) => c.key === sortKey);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (col?.sort === "number") {
        return ((a.nums?.[sortKey] ?? -1) - (b.nums?.[sortKey] ?? -1)) * dir;
      }
      return (a.cells[sortKey] || "").localeCompare(b.cells[sortKey] || "", "pt-BR") * dir;
    });
  }, [needle, sortDir, sortKey, table]);
  const modoBusca = buscaRemota?.modo || "";
  const [lista, setLista] = useState(table.rows);
  const [avisoBusca, setAvisoBusca] = useState("");
  const [dia, setDia] = useState(buscaRemota?.dia || "");
  const [andamento, setAndamento] = useState<AndamentoAberto | null>(null);
  const baseLista = modoBusca === "processos" || modoBusca === "agenda" ? lista : rows;
  const filtrados =
    modoBusca === "agenda" && needle
      ? baseLista.filter((row) => Object.values(row.cells).join(" ").toLowerCase().includes(needle))
      : baseLista;
  const visiveis = modoBusca
    ? [...filtrados].sort(
        (a, b) =>
          (a.cells[sortKey] || "").localeCompare(b.cells[sortKey] || "", "pt-BR") *
          (sortDir === "asc" ? 1 : -1)
      )
    : filtrados;

  useEffect(() => {
    if (modoBusca !== "processos" || !buscaRemota) return;
    if (needle.length < 2) {
      setLista(table.rows);
      setAvisoBusca("");
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v/${buscaRemota.token}/facejus?q=${encodeURIComponent(needle)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data) => {
          setLista(cardsDeBusca(Array.isArray(data.itens) ? data.itens : [], "processos"));
          setAvisoBusca(String(data.aviso || ""));
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [needle, modoBusca, buscaRemota, table.rows]);

  async function mudarDia(valor: string) {
    if (!buscaRemota) return;
    setDia(valor);
    const res = await fetch(`/api/v/${buscaRemota.token}/facejus?agenda=1&dia=${encodeURIComponent(valor)}`);
    const data = await res.json();
          setLista(cardsDeBusca(Array.isArray(data.itens) ? data.itens : [], "agenda", buscaRemota.natureza));
    setAvisoBusca(Array.isArray(data.itens) && data.itens.length ? "" : "Nenhum compromisso nesta data.");
  }

  async function verAndamento(numero: string) {
    if (!buscaRemota) return;
    setAndamento({ titulo: numero, loading: true, novos: [], legado: null });
    const res = await fetch(
      `/api/v/${buscaRemota.token}/facejus?andamento=1&numero=${encodeURIComponent(numero)}`
    );
    const data = await res.json();
    setAndamento({
      titulo: numero,
      loading: false,
      erro: data.encontrado === false ? "Não achei o andamento deste processo." : "",
      novos: Array.isArray(data.novos) ? data.novos : [],
      legado: data.legado || null,
    });
  }

  function toggle(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "valor" ? "desc" : "asc");
  }

  function abrir(ficha: VisualFicha | undefined, related: VisualFicha[] = []) {
    if (!ficha?.nome && !ficha?.documento) return;
    setStack([{ ficha: ficha || {}, related }]);
  }

  function abrirDentro(ficha: VisualFicha) {
    setStack((atual) => {
      const topo = atual[atual.length - 1];
      const pool = [topo?.ficha, ...(topo?.related || [])].filter((item): item is VisualFicha => Boolean(item?.nome || item?.documento));
      const related = pool.filter((item) => item !== ficha && !(item.papel === ficha.papel && item.nome === ficha.nome));
      return [...atual, { ficha, related }];
    });
  }

  return (
    <section className="vb-card" aria-label={table.title || "Lista"}>
      <h2>{table.title || "Lista"}</h2>
      <input
        className="vb-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={table.search}
        aria-label={table.search}
        enterKeyHint="search"
      />
      <div className="vb-sort">
        <button
          type="button"
          onClick={() => toggle(kind === "agenda" ? "filial" : kind === "processo" ? "numero" : "nome")}
          data-on={sortKey === (kind === "agenda" ? "filial" : kind === "processo" ? "numero" : "nome") ? "1" : "0"}
        >
          {kind === "processo" ? "Processo" : kind === "agenda" ? "Filial" : table.columns.find((c) => c.key === "nome")?.label || "Nome"}
          {sortKey === (kind === "agenda" ? "filial" : kind === "processo" ? "numero" : "nome") ? (sortDir === "asc" ? " A–Z" : " Z–A") : ""}
        </button>
        <button
          type="button"
          onClick={() => toggle(kind === "processo" ? "status" : kind === "agenda" ? "partes" : "valor")}
          data-on={sortKey === (kind === "processo" ? "status" : kind === "agenda" ? "partes" : "valor") ? "1" : "0"}
        >
          {kind === "processo" ? "Status" : kind === "agenda" ? (/atendimento/i.test(table.title || "") ? "Consulta" : "Prazo") : table.columns.find((c) => c.key === "valor")?.label || "Valor"}
          {sortKey === (kind === "processo" ? "status" : kind === "agenda" ? "partes" : "valor") ? (sortDir === "asc" ? " A–Z" : " Z–A") : ""}
        </button>
      </div>
      {modoBusca === "agenda" ? (
        <div className="vb-agenda-tools">
          <label className="vb-cal">
            Outra data
            <input type="date" value={dia} onChange={(e) => mudarDia(e.target.value)} />
          </label>
          {buscaRemota ? (
            <a className="vb-pdf" href={`/api/v/${buscaRemota.token}/facejus?pdf=1&dia=${encodeURIComponent(dia)}`}>
              Baixar PDF
            </a>
          ) : null}
        </div>
      ) : null}
      <p className="vb-count">
        {avisoBusca
          ? avisoBusca
          : modoBusca
            ? `${visiveis.length} ${noun(table.title, visiveis.length, kind)}`
            : rows.length === table.rows.length
              ? `${rows.length} ${noun(table.title, rows.length, kind)}`
              : `${rows.length} de ${table.rows.length}`}
      </p>
      <ul className="vb-people">
        {visiveis.map((row, index) => {
          const doc = row.ficha?.documento || (row.cells.doc !== "—" ? row.cells.doc : "");
          const carros = (row.related || []).filter((item) => item.papel === "veiculo");
          const pessoa = (row.related || []).find((item) => item.papel === "locatario");
          if (kind === "agenda") {
            const anterior = visiveis[index - 1];
            const abreFilial = !anterior || anterior.cells.filial !== row.cells.filial;
            const hora = row.cells.numero && row.cells.numero !== "21:00" && row.cells.numero !== "00:00"
              ? row.cells.numero
              : "";
            return (
              <li className="vb-prazo" key={`${row.cells.filial}-${row.cells.partes}-${row.cells.doc}`}>
                {abreFilial ? <span className="vb-grupo">{row.cells.filial || "Sem filial"}</span> : null}
                <div className="vb-prazo-row">
                  {hora ? <span className="vb-hora">{hora}</span> : null}
                  <div>
                    <strong>{row.cells.partes}</strong>
                    {row.cells.area ? <span className="vb-meta">{row.cells.area}</span> : null}
                    {row.cells.doc ? <span className="vb-meta">{row.cells.doc}</span> : null}
                  </div>
                </div>
              </li>
            );
          }
          if (kind === "processo") {
            return (
              <li className="vb-person" key={`${row.cells.numero}-${row.cells.partes}`}>
                <div className="vb-person-head">
                  <button type="button" className="vb-name" onClick={() => abrir(row.ficha)}>
                    {row.cells.numero}
                  </button>
                  <span className="vb-chip vb-chip-inline" data-tone={chipTone(row.cells.status || "")}>
                    {row.cells.status}
                  </span>
                </div>
                <span className="vb-meta">{row.cells.partes}</span>
                <span className="vb-meta">
                  {[row.cells.area, row.cells.filial].filter((v) => v && v !== "—").join(" · ") || "—"}
                </span>
                {row.ficha?.data ? <span className="vb-meta">{row.ficha.data}</span> : null}
                <button type="button" className="vb-open" onClick={() => abrir(row.ficha)}>
                  Abrir ficha
                </button>
                {modoBusca === "processos" ? (
                  <button type="button" className="vb-open" onClick={() => verAndamento(row.cells.numero)}>
                    Ver andamento
                  </button>
                ) : null}
              </li>
            );
          }
          if (kind === "locatario") {
            return (
              <li className="vb-person" key={`${row.cells.nome}-${doc}-${row.cells.placas}`}>
                <div className="vb-person-head">
                  <button type="button" className="vb-name" onClick={() => abrir(row.ficha, carros)}>
                    {row.cells.nome}
                  </button>
                  {row.ficha?.ativo ? (
                    <span className="vb-chip vb-chip-inline" data-tone="ok">
                      {row.ficha.ativo}
                    </span>
                  ) : null}
                </div>
                {carros.length ? (
                  <div className="vb-placas">
                    {carros.map((carro) => (
                      <button
                        type="button"
                        className="vb-placa"
                        key={carro.nome}
                        onClick={() => abrir(carro, [row.ficha || { nome: row.cells.nome }, ...carros.filter((c) => c.nome !== carro.nome)])}
                      >
                        {carro.nome}
                      </button>
                    ))}
                  </div>
                ) : null}
                {doc ? <span className="vb-cpf">{doc}</span> : null}
                {row.ficha?.telefone ? (
                  row.ficha.telefone_href ? (
                    <a className="vb-phone" href={row.ficha.telefone_href} target="_blank" rel="noopener noreferrer">
                      {row.ficha.telefone}
                    </a>
                  ) : (
                    <span className="vb-phone">{row.ficha.telefone}</span>
                  )
                ) : null}
                {row.ficha?.proxima ? <span className="vb-meta">{linhaProxima(row.ficha.proxima)}</span> : null}
                <span className="vb-chip" data-tone={chipTone(row.cells.situacao || "")}>
                  {row.cells.situacao}
                </span>
                <button type="button" className="vb-open" onClick={() => abrir(row.ficha, carros)}>
                  Abrir ficha
                </button>
              </li>
            );
          }
          if (kind === "veiculo") {
            return (
              <li className="vb-person" key={`${row.cells.nome}-${row.cells.placas}`}>
                <div className="vb-person-head">
                  <button type="button" className="vb-name" onClick={() => abrir(row.ficha, pessoa ? [pessoa] : [])}>
                    {row.cells.nome}
                  </button>
                  <span className="vb-chip vb-chip-inline" data-tone={chipTone(row.cells.situacao || "")}>
                    {row.cells.situacao}
                  </span>
                </div>
                {row.cells.data && row.cells.data !== "—" ? <span className="vb-meta">{row.cells.data}</span> : null}
                {pessoa ? (
                  <button type="button" className="vb-pessoa" onClick={() => abrir(pessoa, carros.length ? carros : row.ficha ? [row.ficha] : [])}>
                    {pessoa.nome}
                  </button>
                ) : (
                  <span className="vb-meta">{row.cells.placas}</span>
                )}
                {row.ficha?.local ? <span className="vb-meta">{row.ficha.local}</span> : null}
                <button type="button" className="vb-open" onClick={() => abrir(row.ficha, pessoa ? [pessoa] : [])}>
                  Abrir ficha
                </button>
              </li>
            );
          }
          return (
            <li className="vb-person" key={`${row.cells.nome}-${row.cells.doc}-${row.cells.placas}`}>
              <strong>{row.cells.nome}</strong>
              <span className="vb-meta">{row.cells.placas}</span>
              {row.ficha?.parcela ? <span className="vb-meta">Parcela {row.ficha.parcela}</span> : null}
              {row.ficha?.telefone ? (
                row.ficha.telefone_href ? (
                  <a className="vb-phone" href={row.ficha.telefone_href} target="_blank" rel="noopener noreferrer">
                    {row.ficha.telefone}
                  </a>
                ) : (
                  <span className="vb-meta">{row.ficha.telefone}</span>
                )
              ) : null}
              <span className="vb-meta">
                {row.cells.valor}
                {row.cells.data && row.cells.data !== "—" ? ` · ${row.cells.data}` : ""}
              </span>
              <span className="vb-chip" data-tone={chipTone(row.cells.situacao || "")}>
                {row.cells.situacao}
              </span>
              {doc ? (
                <button type="button" className="vb-doc" onClick={() => abrir(row.ficha || { nome: row.cells.nome, documento: doc })}>
                  {doc}
                </button>
              ) : row.ficha ? (
                <button type="button" className="vb-doc" onClick={() => abrir(row.ficha)}>
                  Ver ficha
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!visiveis.length ? (
        <p className="vb-note">
          {kind === "processo"
            ? "Nenhum processo com esse texto."
            : kind === "agenda"
              ? "Nenhum compromisso nesta data."
              : kind === "veiculo"
                ? "Nenhum veículo com esse texto."
                : "Ninguém com esse texto."}
        </p>
      ) : null}
      {andamento ? (
        <div className="vb-sheet" role="dialog" aria-modal="true" aria-label="Andamento">
          <div className="vb-sheet-card">
            <div className="vb-sheet-actions">
              <button type="button" className="vb-sheet-close" onClick={() => setAndamento(null)}>
                Fechar
              </button>
            </div>
            <p className="vb-kicker">Andamento</p>
            <h2>{andamento.titulo}</h2>
            {andamento.loading ? <p className="vb-note">Buscando o andamento…</p> : null}
            {andamento.erro ? <p className="vb-note">{andamento.erro}</p> : null}
            <h3>Andamento atual</h3>
            {andamento.novos.length ? (
              <ul className="vb-andamentos">
                {andamento.novos.map((item, i) => (
                  <li key={`${item.data}-${item.titulo}-${i}`}>
                    <strong>{[item.data, item.titulo].filter(Boolean).join(" · ")}</strong>
                    {item.texto ? <pre className="vb-legado">{item.texto}</pre> : null}
                  </li>
                ))}
              </ul>
            ) : andamento.loading ? null : (
              <p className="vb-note">Sem andamento novo neste processo.</p>
            )}
            <h3>Histórico legado</h3>
            {andamento.legado?.texto ? (
              <pre className="vb-legado">{andamento.legado.texto}</pre>
            ) : andamento.loading ? null : (
              <p className="vb-note">Sem observação legada da migração.</p>
            )}
          </div>
        </div>
      ) : null}
      {aberta ? (
        <FichaSheet
          aberta={aberta}
          podeVoltar={stack.length > 1}
          onClose={() => setStack([])}
          onBack={() => setStack((atual) => atual.slice(0, -1))}
          onOpen={abrirDentro}
          onAndamento={modoBusca === "processos" ? verAndamento : undefined}
        />
      ) : null}
    </section>
  );
}

function DataTable({ table }: { table: VisualTable }) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState("nome");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const filtered = table.rows.filter((row) => {
      if (!needle) return true;
      return table.columns.some((col) =>
        (row.cells[col.key] || "").toLowerCase().includes(needle)
      );
    });
    const col = table.columns.find((c) => c.key === sortKey);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (col?.sort === "number") {
        return ((a.nums?.[sortKey] ?? -1) - (b.nums?.[sortKey] ?? -1)) * dir;
      }
      return (a.cells[sortKey] || "").localeCompare(b.cells[sortKey] || "", "pt-BR") * dir;
    });
  }, [needle, sortDir, sortKey, table]);

  function toggle(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir("asc");
  }

  return (
    <section className="vb-card" aria-label="Investidores">
      <h2>Investidores</h2>
      <input
        className="vb-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={table.search}
        aria-label={table.search}
      />
      <div className="vb-table-wrap">
        <table className="vb-table">
          <thead>
            <tr>
              {table.columns.map((col) => (
                <th key={col.key}>
                  {col.sort ? (
                    <button type="button" onClick={() => toggle(col.key)}>
                      {col.label}
                      {sortKey === col.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.cells.nome}-${row.cells.placas}-${row.cells.data}`}>
                {table.columns.map((col) => (
                  <td key={col.key}>{row.cells[col.key] || "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length ? <p className="vb-note">Nenhum nome com esse texto.</p> : null}
    </section>
  );
}

const COL_COLORS = ["#3dbe6e", "#5b8def", "#7b6fd6", "#e07a3d", "#c47a32", "#e2b43a", "#d45d9a"];

function axisLabel(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} mi`;
  if (n >= 1000) return `${Math.round(n / 1000)} mil`;
  return String(Math.round(n));
}

function ColumnChart({
  title,
  bars,
}: {
  title: string;
  bars: { label: string; value: number; display: string }[];
}) {
  const max = maxOf(bars);
  const ticks = [max, max / 2, 0];
  return (
    <section className="vb-card vb-chart" aria-label={title}>
      <h2>{title}</h2>
      <div className="vb-chart-row">
        <div className="vb-yaxis" aria-hidden="true">
          {ticks.map((t, i) => (
            <span key={i}>{axisLabel(t)}</span>
          ))}
        </div>
        <ul className="vb-cols">
          {bars.map((b, i) => (
            <li key={`${b.label}-${i}`}>
              <strong>{b.value > 0 ? b.display : ""}</strong>
              <div className="vb-col-track">
                <i
                  style={{
                    height: `${b.value > 0 ? Math.max(8, Math.round((b.value / max) * 100)) : 0}%`,
                    background: COL_COLORS[i % COL_COLORS.length],
                  }}
                />
              </div>
              <em>{b.label}</em>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function DevPainel({ board }: { board: VisualBoardPayload }) {
  const aviso = board.alerts[0];
  return (
    <>
      <h1>{board.title}</h1>
      {board.subtitle ? <p className="vb-sub">{board.subtitle}</p> : null}
      {board.kpis.length ? (
        <ul className="vb-kpis">
          {board.kpis.map((k) => (
            <li key={k.label} data-tone={k.tone || "ok"}>
              <strong>{k.value}</strong>
              <span>{k.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {aviso ? (
        <section className="vb-callout">
          <strong>{aviso.title}</strong>
          {aviso.detail ? <p>{aviso.detail}</p> : null}
        </section>
      ) : null}
      {board.bars.length ? (
        <ColumnChart title={board.barsTitle || "Por dia"} bars={board.bars} />
      ) : null}
      {board.rows.length ? (
        <section className="vb-card" aria-label={board.rowsTitle || "Contas"}>
          <h2>{board.rowsTitle || "Contas"}</h2>
          <ul className="vb-rows">
            {board.rows.map((r) => (
              <li key={`${r.title}-${r.value || ""}`}>
                <div>{r.title}</div>
                {r.value ? <strong>{r.value}</strong> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {board.note ? <p className="vb-note">{board.note}</p> : null}
    </>
  );
}

export function BoardView({
  board,
  token,
  facejus,
}: {
  board: VisualBoardPayload | null;
  token?: string;
  facejus?: {
    modo: "processos" | "agenda";
    dia?: string;
    natureza?: "processual" | "administrativo" | null;
  } | null;
}) {
  const dev = board?.kind === "dev";
  return (
    <main className={dev ? "vb vb-dev" : "vb"}>
      <div className="vb-wrap">
        <div className="vb-brand">
          <img
            src="/brand/moope-assessor-logo.png"
            alt="MOOPE Assessor"
            width={56}
            height={56}
          />
          <div>
            <strong>MOOPE Assessor</strong>
            <span>{board?.org || "no WhatsApp"}</span>
          </div>
        </div>

        {!board ? (
          <div className="vb-empty">
            <h1>Este link já não abre</h1>
            <p className="vb-sub">
              Peça de novo no WhatsApp. O link vale 24 horas e só abre aquela consulta.
            </p>
            <p>
              A lista do que pedir está em <a href="/painel">/painel</a>.
            </p>
          </div>
        ) : dev ? (
          <DevPainel board={board} />
        ) : (
          <>
            <h1>{board.title}</h1>
            {board.subtitle ? <p className="vb-sub">{board.subtitle}</p> : null}

            {board.kpis.length ? (
              <ul className="vb-kpis">
                {board.kpis.map((k) => (
                  <li key={k.label} data-tone={k.tone || "ok"}>
                    <span>{k.label}</span>
                    <strong>{k.value}</strong>
                  </li>
                ))}
              </ul>
            ) : null}

            {board.donut?.length ? (
              <section className="vb-card" aria-label={board.donutTitle || "Gráfico"}>
                <h2>{board.donutTitle || "Gráfico"}</h2>
                <Donut parts={board.donut} />
              </section>
            ) : null}

            {board.compare?.length ? (
              <Bars title={board.compareTitle || "Comparativo"} bars={board.compare} money />
            ) : null}

            {board.bars.length ? (
              <Bars title={board.barsTitle || "Comparativo"} bars={board.bars} />
            ) : null}

            {board.alerts.length ? (
              <section className="vb-card" aria-label="Alertas">
                <h2>Para olhar</h2>
                <ul className="vb-alerts">
                  {board.alerts.map((a) => (
                    <li key={a.title}>
                      <div>
                        {a.title}
                        {a.detail ? <small>{a.detail}</small> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {board.table ? (
              board.table.layout === "cards" ? (
                <PessoaCards
                  table={board.table}
                  buscaRemota={
                    token && facejus
                      ? { token, modo: facejus.modo, dia: facejus.dia, natureza: facejus.natureza }
                      : undefined
                  }
                />
              ) : board.table.rows.length ? (
                <DataTable table={board.table} />
              ) : null
            ) : null}

            {board.rows.length ? (
              <section className="vb-card" aria-label={board.rowsTitle || "Lista"}>
                <h2>{board.rowsTitle || "Detalhe"}</h2>
                <ul className="vb-rows">
                  {board.rows.map((r) => (
                    <li key={`${r.title}-${r.value || ""}-${r.detail || ""}`}>
                      <div>
                        {r.title}
                        {r.detail ? <small>{r.detail}</small> : null}
                      </div>
                      {r.value ? <strong>{r.value}</strong> : null}
                      {r.href ? (
                        <a href={r.href} target="_blank" rel="noopener noreferrer">
                          {r.hrefLabel || "Abrir"}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {board.links?.length ? (
              <section className="vb-card" aria-label="Sistema">
                <div className="vb-links">
                  {board.links.map((l) => (
                    <a
                      key={l.href}
                      className="vb-more"
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {l.label}
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            {token && board.downloads?.length ? (
              <section className="vb-card" aria-label="Arquivos">
                <h2>Baixar</h2>
                <div className="vb-downloads">
                  {board.downloads.map((d) => (
                    <a
                      key={d.kind}
                      className="vb-dl"
                      href={`/api/v/${token}/arquivo?kind=${encodeURIComponent(d.kind)}`}
                    >
                      {d.label}
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            {board.note ? <p className="vb-note">{board.note}</p> : null}
            <p className="vb-foot">
              <a href="/painel">O que pedir para abrir o seu</a>
              {" · "}
              MOOPE Assessor
            </p>
          </>
        )}
      </div>
    </main>
  );
}
