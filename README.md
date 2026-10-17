# Ventas · FG Agro

App para el móvil Android que sustituye a `Gestion_Ventas_3.0.xlsx`: ventas por pedido, compras, stock a precio medio, tarifa, deudas de clientes y comisiones. Funciona sin conexión. Clientes y productos salen de los maestros compartidos de Drive (Apps › Maestros).

**El código no lleva datos** (el repositorio es público). En un móvil nuevo la app empieza vacía y se restaura desde la hoja de Google («Restaurar desde la hoja») o desde un fichero de copia (Ajustes → «Restaurar desde fichero»). El histórico del Excel está guardado como copia en Drive › Apps › Copia de seguridad.

- **Inicio:** ventas, beneficio y margen del año (total y solo clientes), tus fincas, valor del stock, comisiones, beneficio + comisiones, lo que falta por cobrar, gráficas mensuales y productos/clientes que más venden.
- **Ventas:** un pedido por cliente y fecha con varias líneas. El precio sale de la tarifa (o precio medio + 5 % si es una finca propia) y se puede cambiar. Bloquea vender más de lo que hay en stock. Admite líneas de «otro concepto» (portes, abonos…) que no mueven stock.
- **Compras:** cada compra recalcula el precio medio. Una cantidad negativa sirve para corregir el inventario. Desde aquí se dan de alta productos y proveedores nuevos.
- **Stock y tarifa:** existencias, precio medio y valor por producto; la tarifa se edita directamente en la lista.
- **Deudas:** quién te debe, qué artículos y cuánto. Cobros a cuenta que saldan primero los pedidos más antiguos. Listado por cliente o total en texto (WhatsApp) o PDF.
- **Comisiones:** porcentaje o importe fijo, con cobrada/pendiente y sumatorio aparte.

## Reglas de cálculo
- **Coste de cada venta:** precio medio del producto en el momento de guardarla. Queda congelado: cambiar compras después no modifica ventas ya hechas. El histórico conserva el coste del lote del Excel.
- **Precio medio:** (importe de todas las compras − coste de todo lo vendido) ÷ unidades en stock.
- **Tus fincas** (el cliente de tipo «Propio» en el maestro): precio propuesto = precio medio + margen (5 % por defecto, en Ajustes). Quedan pendientes hasta que las marques cobradas al pasarlas a la app de stock de fincas.
- **Cobros:** si bajas el importe de un pedido ya cobrado, lo sobrante se aplica a las otras deudas del cliente.

## Maestros de clientes y productos
Cada cliente y producto queda enlazado a su ficha del maestro (C016, P008…). El nombre, la categoría (las de Stock fincas: Fertilizantes, Fitosanitarios, Herbicidas, Bioestimulantes) y las bajas vienen del maestro y se actualizan solos. Los productos de Ventas son por envase («Complex AID E/10 L» = P008 + envase «E/10 L»).
- El primer enlace y unir fichas repetidas se enseñan antes de aplicarse.
- Un cliente o producto nuevo que no esté en el maestro se crea en la app y se pide su alta: entra en el maestro con el siguiente ID y «Revisar = Sí» (amarillo). Sin conexión queda en cola.
- Ventas solo lee y da altas; nunca cambia ni borra lo que hay en los maestros.
- Configuración: Ajustes → Maestros → dirección y clave del script de maestros (el mismo para todas las apps).

## Publicar (GitHub Pages)
Settings → Pages → rama `main`, carpeta `/ (root)`. Después abrir la dirección en Chrome del móvil → ⋮ → «Instalar aplicación».

## Copia automática en Google Sheets
1. Crea una hoja de Google nueva (por ejemplo «Ventas FG Agro»).
2. Extensiones → Apps Script. Borra lo que haya, pega el contenido de `google-sheets/Codigo.gs` y cambia `CAMBIA-ESTA-CLAVE` por una clave larga propia. Guarda.
3. Implementar → Nueva implementación → tipo «Aplicación web» → Ejecutar como: **Yo** → Quién tiene acceso: **Cualquier usuario** → Implementar. Autoriza los permisos y copia la dirección (termina en `/exec`).
4. En la app: Ajustes → Copia automática en Google Sheets → pega la dirección y la clave → «Probar y activar».

La hoja es un espejo de un solo sentido: la app reescribe las pestañas Resumen, Ventas, Compras, Stock, Pendientes, Cobros y Comisiones en cada envío. La pestaña Ventas mantiene el orden de columnas del Excel (Fecha, Mes, Año, Producto, Cliente, Cantidad, Precio, Importe, Cobro, Coste, Importe coste, Beneficio, Margen, Proveedor…). La clave nunca se sube a GitHub: se guarda solo en el móvil y en el script de tu hoja.

## Actualizaciones
Al cambiar cualquier fichero, sube `VERSION` en `sw.js` para que los móviles recojan la nueva versión.

`vendor/jspdf.umd.min.js` es jsPDF 2.5.2 (licencia MIT), incluido para generar los PDF sin conexión.
