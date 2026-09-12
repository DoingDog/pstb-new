function renderHTML(paste) {
  const seconds = {
    YEAR: 31104000,
    MONTH: 2592000,
    WEEK: 604800,
    DAY: 86400,
    HOUR: 3600,
    MINUTE: 60,
  };
  const icon = "%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' class='feather feather-clipboard'%3E%3Cpath d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'%3E%3C/path%3E%3Crect x='8' y='2' width='8' height='4' rx='1' ry='1'%3E%3C/rect%3E%3C/svg%3E";
  const readOnly = paste.text ? "readonly" : "";
  const pasteText = paste.text ? paste.text : "";
  const pasteTitle = paste.title ? escape(paste.title) : "";
  const pasteSize = paste.text ? (paste.text.length / 1000).toFixed(2) : "";
  const country = paste.country ? new Intl.DisplayNames(["en"], { type: "region" }).of(paste.country) : "Unknown";
  const timeZone = paste.timezone ? paste.timezone : "Unknown";
  const createdAt = paste.createdAt ? new Date(paste.createdAt).toISOString() : "Unknown";
  const expirationDate = paste.createdAt ? new Date(new Date(paste.createdAt).getTime() + paste.expiration * 1000) : "";
  let expiresIn = expirationDate ? (expirationDate - Date.now()) / 1000 : "-1";
  Object.keys(seconds).forEach((key) => {
    if (pasteText && expiresIn / seconds[key] >= 1) expiresIn = `${Math.round(expiresIn / seconds[key])} ${key.toLowerCase()}s`;
  });

  return `
<!DOCTYPE html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pasteText ? (pasteTitle ? pasteTitle : "Untitled") : "Paste"}</title>
  <link rel="icon" href="data:image/svg+xml,${icon}" />
  <style>
    html,
    body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background-color: #171717;
      color: #b8b8b8;
      font-family: sans-serif;
    }

    body {
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 0;
      max-width: 100%;
      padding: 20px 0;
      box-sizing: border-box;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin: 0 auto;
      max-width: 800px;
      width: 100%;
      padding: 0 20px;
      box-sizing: border-box;
    }

    textarea {
      color: #b8b8b8;
      font-family: sans-serif;
      font-size: medium;
      background-color: #101010;
      border: #3d3d3d 1px solid;
      outline: none;
      padding: 1rem;
      border-radius: 0.5rem;
      resize: none;
      height: 50vh;
      width: 100%;
      box-sizing: border-box;
      overflow-x: auto;
      cursor: auto;
      max-width: 100%;
      margin: 0;
      user-select: none;
    }

    button {
      font-size: medium;
      color: #b8b8b8;
      background-color: #101010;
      border: 1px solid #3d3d3d;
      padding: 1rem;
      border-radius: 0.4rem;
      user-select: none;
      cursor: pointer;
      flex: 1;
      max-width: 100%;
      margin: 0;
    }

    select,
    input[type="text"] {
      color: #b8b8b8;
      background-color: #101010;
      border: 1px solid #3d3d3d;
      border-radius: 0.5rem;
      padding: 0.9rem;
      font-size: medium;
      outline: 0;
      max-width: 100%;
      margin: 0;
      user-select: none;
      flex: 1;
    }

    p {
      color: #777;
      margin: 0;
      cursor: default;
      user-select: none;
      max-width: 100%;
      margin: 0;
    }

    a {
      color: #777;
      cursor: pointer;
      user-select: none;
      text-decoration: underline;
    }

    h2 {
      margin: 0;
      max-width: 100%;
    }

    #information {
      display: flex;
      flex-direction: row;
      gap: 1rem;
      margin: 0;
      max-width: 100%;
      width: 100%;
      box-sizing: border-box;
    }

    @media only screen and (max-width: 600px) {
      textarea {
        font-size: small;
        height: 40vh;
      }

      button {
        font-size: small;
        width: 100%;
        height: 7vh;
      }

      input[type="text"] {
        width: 90%;
        height: 7vh;
        font-size: small;
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
        padding: 1rem;
        line-height: 1.5;
      }
      select {
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
        padding: 1rem;
        line-height: 1.5;
        height: auto;
        width: 100%;
        height: 7vh;
        font-size: small;
      }

      #information {
        flex-direction: column;
        gap: 0.7rem;
        align-items: center;
      }
    }

    ::-webkit-scrollbar {
      height: 4px;
      cursor: default;
    }

    ::-webkit-scrollbar-thumb {
      background-color: rgba(155, 155, 155, 0.5);
      border-radius: 20px;
      border: transparent;
    }
  </style>
  <script>
    function dropHandler(event) {
      const textArea = document.getElementsByName("text")[0];
      if (textArea.readOnly) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function (event) {
          document.getElementsByName("text")[0].value = event.target.result;
        };
        reader.readAsText(file);
        document.getElementsByName("title")[0].value = file.name;
      } else {
        const text = event.dataTransfer.getData("text/plain");
        textArea.value = text;
      }
    }

    function dragOverHandler(event) {
      event.preventDefault();
    }
    function deleteItem(event) {
      event.preventDefault();
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/delete/${paste.uuid}");
      xhr.onreadystatechange = function () {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          if (xhr.status === 200) {
            try {
              const response = JSON.parse(xhr.responseText);
              if (response.success) {
                const link = event.target;
                link.parentNode.replaceChild(document.createTextNode(response.message || "Deleted"), link);
              } else {
                console.log("Delete failed:", response.message);
              }
            } catch (e) {
              const link = event.target;
              link.parentNode.replaceChild(document.createTextNode("Deleted"), link);
            }
          } else {
            console.log("Delete Fail");
          }
        }
      };
      xhr.send();
    }
    function copyText(event) {
      event.preventDefault();
      const textArea = document.getElementsByName("text")[0];
      textArea.select();
      document.execCommand("copy");
      const link = event.target;
      link.parentNode.replaceChild(document.createTextNode("Copied"), link);
    }
    function toggleWrap() {
      var textarea = document.getElementsByName("text")[0];
      var linkText = document.getElementById("wrapLink");
      if (textarea.getAttribute("wrap") == "soft") {
        textarea.setAttribute("wrap", "off");
        linkText.innerHTML = "Wrap";
      } else {
        textarea.setAttribute("wrap", "soft");
        linkText.innerHTML = "Unwrap";
      }
    }
  </script>
</head>
<body>
  <form action="/" method="post">
    ${pasteText ? `<div style="display: flex; gap: 1rem; justify-content: space-between; align-items: center;"><h2>${pasteTitle || "Untitled"}</h2><div style="text-align: right;"><a href="#" onclick="toggleWrap()" id="wrapLink">Wrap</a></div></div>` : '<div style="text-align: right;"><a href="#" onclick="toggleWrap()" id="wrapLink">Wrap</a></div>'}
    <textarea wrap="off" name="text" placeholder="Paste your text..." ${readOnly} spellcheck="false" required ondrop="dropHandler(event)" ondragover="dragOverHandler(event)">${pasteText}</textarea>
    ${
      pasteText
        ? `<p>Paste was created in ${country} at <span style="text-decoration: underline;text-decoration_-style: dotted;" title="${new Date(createdAt).toLocaleString("en-us", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}">${createdAt}</span>, expires in ${expiresIn} and has ${pasteSize} kb <br> <center> <a href=/raw/${paste.uuid}>raw</a> | <a href=/html/${paste.uuid}>html</a> | <a href=/file/${paste.uuid}>file</a> <br> <a id=copy-link href=# onclick=copyText(event)>copy text</a> | <a href="/" target="_blank">create new</a> | <a href=# onclick=deleteItem(event)>delete now</a></center> </p>`
        : `<div id='information'><input type='text' name='title' placeholder='Paste Title'><select name='expiration' required><option disabled value=''>Select expiration</option><option value='${seconds.MINUTE}'>1 Minute</option><option value='${seconds.HOUR}'>1 Hour</option><option value='${seconds.DAY}' selected>1 Day</option><option value='${seconds.WEEK}'>1 Week</option><option value='${seconds.MONTH}'>1 Month</option><option value='${seconds.YEAR}'>1 Year</option></select><button>Create paste</button></div>`
    }
  </form>
</body>
`;
}

function renderError({ message }) {
  const icon = "%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' class='feather feather-clipboard'%3E%3Cpath d='M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'%3E%3C/path%3E%3Crect x='8' y='2' width='8' height='4' rx='1' ry='1'%3E%3C/rect%3E%3C/svg%3E";
  return `
<!DOCTYPE html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:image/svg+xml,${icon}" />
  <title>Paste</title>
  <style>
    body,
    html {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background-color: #171717;
      color: #b8b8b8;
      font-family: sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 0.5rem;
    }
    h1 {
      color: #777;
      margin: 0;
      cursor: default;
      text-align: center;
    }
    a {
      color: #777;
    }
  </style>
</head>
<body>
  <h1>${message}</h1>
  <a href="/">Go back</a>
</body>
`;
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request).catch(({ stack }) => new Response(stack, { status: 500 })));
});

async function handleRequest(request) {
  const { pathname } = new URL(request.url);
  const { headers } = request;
  let body = {};
  async function deletePasteFromDB(uuid) {
    await PASTE_DB.delete(uuid);
  }
  if (pathname === "/") {
    if (request.method === "GET") {
      return new Response(renderHTML({}), {
        headers: { "Content-Type": "text/html;charset=utf8" },
      });
    }
    if (request.method === "POST") {
      const contentType = headers.get("content-type") || "";
      if (contentType.includes("form")) {
        const formData = await request.formData();
        const pasteText = formData.get("text");
        const pasteLength = new TextEncoder().encode(pasteText).length;
        if (pasteLength > 0 && pasteLength <= 10485760) {
          const title = formData.get("title");
          const uuid = crypto.randomUUID();
          const country = request.cf.country;
          const createdAt = Date.now();
          const ip = headers.get("CF-Connecting-IP");
          const expiration = parseInt(formData.get("expiration")) !== 0 ? parseInt(formData.get("expiration")) : 1;
          let options = {
            expirationTtl: expiration,
            metadata: { country, createdAt, ip, title, expiration },
          };
          await PASTE_DB.put(uuid, pasteText, options);
          return Response.redirect(`${request.url}${uuid}`, 302);
        } else {
          return new Response(
            renderError({
              message: "Paste is either too big or empty. Limit: 10MB",
            }),
            { headers: { "Content-Type": "text/html;charset=utf8" }, status: 413 }
          );
        }
      }
    }
  } else if (pathname.startsWith("/raw/")) {
    if (request.method === "GET") {
      const uuid = pathname.split("/raw/")[1];
      const value = await PASTE_DB.get(uuid);
      if (value != null) {
        return new Response(value, {
          headers: { "Content-Type": "text/plain;charset=utf8" },
        });
      } else {
        return new Response("Error: Paste not found", {
          headers: { "Content-Type": "text/plain;charset=utf8" },
          status: 404,
        });
      }
    }
  } else if (pathname.startsWith("/html/")) {
    if (request.method === "GET") {
      const uuid = pathname.split("/html/")[1];
      const value = await PASTE_DB.get(uuid);
      if (value != null) {
        return new Response(value, {
          headers: { "Content-Type": "text/html;charset=utf8" },
        });
      } else {
        return new Response(renderError({ message: "Paste not found" }), {
          headers: { "Content-Type": "text/html;charset=utf8" },
          status: 404,
        });
      }
    }
  } else if (pathname.startsWith("/file/")) {
    if (request.method === "GET") {
      const uuid = pathname.split("/file/")[1];
      const { value, metadata } = await PASTE_DB.getWithMetadata(uuid);
      if (value != null) {
        return new Response(value, {
          headers: {
            "Content-Disposition": `attachment; filename="${metadata.title}"`,
          },
        });
      } else {
        return new Response("Error: Paste not found", {
          headers: { "Content-Type": "text/plain;charset=utf8" },
          status: 404,
        });
      }
    }
  } else if (pathname.startsWith("/delete/")) {
    if (request.method === "GET") {
      const uuid = pathname.split("/delete/")[1];
      await deletePasteFromDB(uuid);
      return new Response(JSON.stringify({ success: true, message: "Deleted" }), {
        headers: { "Content-Type": "application/json;charset=utf8" },
      });
    }
  } else if (pathname === "/api") {
    if (request.method === "GET" || request.method === "POST") {
      let content = "";
      let expiration = 86400; // default 1 day
      let title = "";

      if (request.method === "GET") {
        const url = new URL(request.url);
        content = url.searchParams.get("content") || "";
        expiration = parseInt(url.searchParams.get("expiration")) || 86400;
        title = url.searchParams.get("title") || "";
      } else if (request.method === "POST") {
        const contentType = headers.get("content-type") || "";
        if (contentType.includes("json")) {
          const jsonData = await request.json();
          content = jsonData.content || "";
          expiration = parseInt(jsonData.expiration) || 86400;
          title = jsonData.title || "";
        } else if (contentType.includes("form")) {
          const formData = await request.formData();
          content = formData.get("content") || "";
          expiration = parseInt(formData.get("expiration")) || 86400;
          title = formData.get("title") || "";
        } else {
          const text = await request.text();
          content = text;
        }
      }

      const pasteLength = new TextEncoder().encode(content).length;
      if (pasteLength > 0 && pasteLength <= 10485760) {
        const uuid = crypto.randomUUID();
        const country = request.cf.country;
        const createdAt = Date.now();
        const ip = headers.get("CF-Connecting-IP");
        const finalExpiration = expiration > 0 ? expiration : 1;
        let options = {
          expirationTtl: finalExpiration,
          metadata: { country, createdAt, ip, title, expiration: finalExpiration },
        };
        await PASTE_DB.put(uuid, content, options);

        const protocol = request.headers.get("x-forwarded-proto") || "https";
        const host = request.headers.get("host") || new URL(request.url).hostname;
        const baseUrl = `${protocol}://${host}`;

        return new Response(
          JSON.stringify({
            success: true,
            uuid: uuid,
            location: uuid,
            url: `${baseUrl}/raw/${uuid}`,
            raw_url: `${baseUrl}/raw/${uuid}`,
            html_url: `${baseUrl}/html/${uuid}`,
            view_url: `${baseUrl}/${uuid}`,
            expiry: finalExpiration,
          }),
          {
            headers: { "Content-Type": "application/json;charset=utf8" },
          }
        );
      } else {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Paste is either too big or empty. Limit: 10MB",
          }),
          {
            headers: { "Content-Type": "application/json;charset=utf8" },
            status: 413,
          }
        );
      }
    }
  } else {
    if (request.method === "GET") {
      const uuid = pathname.split("/")[1];
      const { value, metadata } = await PASTE_DB.getWithMetadata(uuid);
      if (value != null) {
        return new Response(
          renderHTML({
            uuid,
            text: value,
            country: metadata.country,
            createdAt: metadata.createdAt,
            expiration: metadata.expiration,
            title: metadata.title,
            timezone: request.cf.timezone,
          }),
          { headers: { "Content-Type": "text/html;charset=utf8" } }
        );
      } else {
        return new Response(renderError({ message: "Paste not found" }), {
          headers: { "Content-Type": "text/html;charset=utf8" },
          status: 404,
        });
      }
    }
  }
}
