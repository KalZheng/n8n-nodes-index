// Global data structure from data.js: nodesData

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const nodesListEl = document.getElementById('nodeList');
    const searchInput = document.getElementById('searchInput');
    const nodeCountEl = document.getElementById('nodeCount');
    const themeToggle = document.getElementById('themeToggle');
    
    const mainContent = document.getElementById('mainContent');
    const emptyState = document.getElementById('emptyState');
    const nodeDetails = document.getElementById('nodeDetails');

    // Detail Panel Elements
    const dName = document.getElementById('detailName');
    const dVersion = document.getElementById('detailVersion');
    const dTags = document.getElementById('detailTags');
    const dSubtitle = document.getElementById('detailSubtitle');
    const dDescription = document.getElementById('detailDescription');
    const dDocs = document.getElementById('detailDocs');
    const dInputs = document.getElementById('detailInputs');
    const dOutputs = document.getElementById('detailOutputs');
    const dCreds = document.getElementById('detailCredentials');
    const dPropsBody = document.getElementById('detailPropsBody');
    const dExample = document.getElementById('detailExample');
    const copyBtn = document.getElementById('copyExampleBtn');
    
    const countInputs = document.getElementById('inputCount');
    const countOutputs = document.getElementById('outputCount');
    const countProps = document.getElementById('propCount');

    let currentNodes = [...nodesData];
    let selectedNodeId = null;

    // Initialize
    renderList();
    setupThemeToggle();

    // Event Listeners
    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        currentNodes = nodesData.filter(n => {
            const matchName = n.name && n.name.toLowerCase().includes(term);
            const matchAlias = n.alias && n.alias.some(a => a.toLowerCase().includes(term));
            const matchDesc = n.description && n.description.toLowerCase().includes(term);
            return matchName || matchAlias || matchDesc;
        });
        renderList();
    });

    copyBtn.addEventListener('click', () => {
        const text = dExample.textContent;
        navigator.clipboard.writeText(text).then(() => {
            const original = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = original, 2000);
        });
    });

    // Theme logic
    function setupThemeToggle() {
        const savedTheme = localStorage.getItem('n8n-viewer-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
        themeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

        themeToggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('n8n-viewer-theme', next);
            themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
        });
    }

    // List Rendering
    function renderList() {
        nodesListEl.innerHTML = '';
        nodeCountEl.textContent = `${currentNodes.length} node${currentNodes.length !== 1 ? 's' : ''}`;

        currentNodes.forEach((node, index) => {
            const li = document.createElement('li');
            li.className = `node-item ${selectedNodeId === index ? 'active' : ''}`;
            
            const nameEl = document.createElement('div');
            nameEl.className = 'node-item-name';
            nameEl.textContent = node.name || 'Unknown Node';
            
            const typeEl = document.createElement('div');
            typeEl.className = 'node-item-type';
            typeEl.textContent = node.type || 'regular';

            li.appendChild(nameEl);
            li.appendChild(typeEl);
            
            li.addEventListener('click', () => selectNode(node, index, li));
            
            nodesListEl.appendChild(li);
        });
    }

    // Node Selection
    function selectNode(node, index, liElement) {
        selectedNodeId = index;
        
        // Update active class
        document.querySelectorAll('.node-item').forEach(el => el.classList.remove('active'));
        if (liElement) liElement.classList.add('active');

        emptyState.classList.add('hidden');
        nodeDetails.classList.remove('hidden');

        // Populate header
        dName.textContent = node.name || 'Unnamed Node';
        dVersion.textContent = `v${node.version || '1.0'}`;
        dSubtitle.textContent = node.subtitle || '';
        dDescription.textContent = node.description || '';
        
        if (node.documentationUrl) {
            dDocs.href = node.documentationUrl;
            dDocs.classList.remove('hidden');
        } else {
            dDocs.classList.add('hidden');
        }

        // Tags
        dTags.innerHTML = '';
        
        // Type badge
        const typeBadge = document.createElement('span');
        typeBadge.className = 'badge badge-type';
        typeBadge.textContent = node.type || 'regular';
        dTags.appendChild(typeBadge);

        // Categories
        if (node.categories && node.categories.length) {
            node.categories.forEach(cat => {
                const b = document.createElement('span');
                b.className = 'badge badge-category';
                b.textContent = cat;
                dTags.appendChild(b);
            });
        }
        
        // Aliases (max 3 to save space)
        if (node.alias && node.alias.length) {
            node.alias.slice(0, 3).forEach(al => {
                const b = document.createElement('span');
                b.className = 'badge badge-alias';
                b.textContent = al;
                dTags.appendChild(b);
            });
            if (node.alias.length > 3) {
                const b = document.createElement('span');
                b.className = 'badge badge-alias';
                b.textContent = `+${node.alias.length - 3} more`;
                dTags.appendChild(b);
            }
        }

        // I/O
        renderTags(dInputs, node.inputs);
        countInputs.textContent = node.inputs ? node.inputs.length : '0';
        
        renderTags(dOutputs, node.outputs);
        countOutputs.textContent = node.outputs ? node.outputs.length : '0';

        // Credentials
        dCreds.innerHTML = '';
        if (node.credentials && node.credentials.length) {
            node.credentials.forEach(cred => {
                const c = document.createElement('div');
                c.className = 'io-tag';
                c.textContent = cred.name || 'Unknown Credential';
                dCreds.appendChild(c);
            });
        } else {
            dCreds.innerHTML = '<span class="empty-txt">None required</span>';
        }

        // Properties Table
        dPropsBody.innerHTML = '';
        const props = (node.properties || []).filter(p => !p._spread && p.name);
        countProps.textContent = props.length.toString();
        
        if (props.length === 0) {
            dPropsBody.innerHTML = '<tr><td colspan="4" class="empty-txt" style="text-align:center;">No direct properties (or only spreads)</td></tr>';
        } else {
            props.forEach(p => {
                const tr = document.createElement('tr');
                
                // Name
                const tdName = document.createElement('td');
                tdName.className = 'prop-name';
                tdName.innerHTML = `
                    ${p.name}
                    ${p.displayName ? `<br><span style="font-size:0.75rem; color:var(--text-secondary); font-family:var(--font-sans)">${p.displayName}</span>` : ''}
                `;
                
                // Type
                const tdType = document.createElement('td');
                tdType.innerHTML = `<span class="prop-type">${p.type || 'unknown'}</span>`;
                
                // Default
                const tdDefault = document.createElement('td');
                let defVal = p.default;
                if (typeof defVal === 'object' && defVal !== null) defVal = JSON.stringify(defVal);
                if (defVal === undefined || defVal === '') defVal = '<span class="empty-txt">empty</span>';
                tdDefault.innerHTML = `<span style="font-family:monospace">${defVal}</span>`;
                
                // Required
                const tdReq = document.createElement('td');
                if (p.required) {
                    tdReq.innerHTML = '<span class="prop-required">Yes</span>';
                } else {
                    tdReq.innerHTML = '<span style="color:var(--text-secondary)">No</span>';
                }

                tr.appendChild(tdName);
                tr.appendChild(tdType);
                tr.appendChild(tdDefault);
                tr.appendChild(tdReq);
                dPropsBody.appendChild(tr);
            });
        }

        // Example
        dExample.textContent = JSON.stringify(node.example || {}, null, 2);
    }

    function renderTags(container, arr) {
        container.innerHTML = '';
        if (!arr || !arr.length) {
            container.innerHTML = '<span class="empty-txt">None</span>';
            return;
        }
        arr.forEach(item => {
            const el = document.createElement('div');
            el.className = 'io-tag';
            el.textContent = typeof item === 'object' ? item.type || JSON.stringify(item) : String(item);
            container.appendChild(el);
        });
    }
});
