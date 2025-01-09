const socket = io.connect('/'); // Connect to the WebSocket server
let runFlag = true;
let minPL = 0;

// WebSocket connection error handling
socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
  alert('Failed to connect to the server. Please try again later.');
});

socket.on('connect_timeout', () => {
  console.error('Socket connection timed out');
  alert('Connection to the server timed out. Please try again later.');
});

socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason);
  alert('You have been disconnected from the server. Please check your connection.');
});

const runToggle = () => {
  runFlag = !runFlag;
  const runButton = document.getElementById('runDiv');
  runButton.innerHTML = `
    <button onclick="runToggle();" type="button" class="btn ${runFlag ? 'btn-success' : 'btn-danger'}" id="runFlag">
      Toggle
    </button>
  `;
};

const minLimit = (ml) => {
  // Ensure minPL is a valid number
  minPL = parseFloat(ml);
  if (isNaN(minPL)) {
    minPL = 0; // Default to 0 if invalid input
  }
};

socket.on('ARBITRAGE', (pl) => {
  if (runFlag) {
    // Select the table body where the data will be inserted
    const tableBody = document.getElementById('tartbitBody');
    
    // Clear the table before inserting new data
    tableBody.innerHTML = '';

    // Filter the data based on minPL and create table rows
    const filteredData = pl.filter((p) => p.value >= minPL);
    
    // If there is data to display
    if (filteredData.length > 0) {
      filteredData.forEach((d, i) => {
        const row = document.createElement('tr');
        row.classList.add('table-success');
        
        // Sanitize and insert each cell value into the row
        const indexCell = document.createElement('td');
        indexCell.textContent = i + 1; // Index + 1
        row.appendChild(indexCell);
        
        const tpathCell = document.createElement('td');
        tpathCell.textContent = d.tpath; // Assuming 'tpath' is a safe string
        row.appendChild(tpathCell);
        
        const valueCell = document.createElement('td');
        valueCell.textContent = d.value; // Assuming 'value' is a numeric field
        row.appendChild(valueCell);
        
        // Append the row to the table body
        tableBody.appendChild(row);
      });
    } else {
      // If no data found after filtering
      const noDataRow = document.createElement('tr');
      const noDataCell = document.createElement('td');
      noDataCell.colSpan = 3;
      noDataCell.textContent = 'No data matching the minimum limit';
      noDataRow.appendChild(noDataCell);
      tableBody.appendChild(noDataRow);
    }
  }
});
