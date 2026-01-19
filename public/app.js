const API_BASE = '';

function formatDate(date) {
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(dateString) {
	const date = new Date(dateString);
	return date.toLocaleString('en-US', { 
		month: 'short', 
		day: 'numeric', 
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});
}

function showSeedMessage(message, type = 'success') {
	const messageDiv = document.getElementById('seedMessage');
	messageDiv.className = type;
	messageDiv.textContent = message;
	setTimeout(() => {
		messageDiv.textContent = '';
		messageDiv.className = '';
	}, 5000);
}

// Load summary data
async function loadSummary() {
	try {
		console.log('Fetching summary from:', `${API_BASE}/api/summary`);
		const response = await fetch(`${API_BASE}/api/summary`);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const data = await response.json();
		console.log('Summary data received:', data);
		
		if (data.ok) {
			document.getElementById('kpiTotal').textContent = data.total;
			document.getElementById('kpiUrgent').textContent = data.urgent;
			document.getElementById('kpiPositive').textContent = data.sentiment?.positive || 0;
			
			// Count analyzed (has theme or sentiment)
			const analyzed = (data.sentiment?.positive || 0) + 
			                 (data.sentiment?.negative || 0) + 
			                 (data.sentiment?.neutral || 0);
			document.getElementById('kpiAnalyzed').textContent = analyzed;

			// Update theme breakdown (ranked list)
			const themeContainer = document.getElementById('themeOverview');
			const themes = data.theme || [];
			
			if (themes.length === 0) {
				themeContainer.innerHTML = '<div class="loading">No themes yet. Analyze some feedback!</div>';
			} else {
				themeContainer.innerHTML = themes.map((theme, index) => {
					// Calculate change from next theme in ranking (shows gap)
					const nextCount = index < themes.length - 1 ? themes[index + 1].count : theme.count;
					const change = theme.count - nextCount;
					const changeText = change > 0 ? `+${change}` : change < 0 ? `${change}` : '0';
					const changeClass = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
					return `
						<div class="theme-row clickable-theme" onclick="filterByTheme('${theme.theme}')">
							<span class="theme-name">[ ${theme.theme} ]</span>
							<span class="theme-stats">
								<span class="theme-total">${theme.count}</span>
								<span class="theme-change ${changeClass}">${changeText}</span>
								<span class="theme-separator">|</span>
								<span class="theme-urgent">${theme.urgent_count || 0} urgent</span>
							</span>
						</div>
					`;
				}).join('');
			}
		} else {
			console.error('Summary API returned error:', data);
		}
	} catch (error) {
		console.error('Error loading summary:', error);
		const kpiTotal = document.getElementById('kpiTotal');
		if (kpiTotal) {
			kpiTotal.textContent = 'Error';
		}
	}
}

// Load type distribution
async function loadTypeDistribution() {
	try {
		const summaryResponse = await fetch(`${API_BASE}/api/summary`);
		if (!summaryResponse.ok) {
			throw new Error(`HTTP error! status: ${summaryResponse.status}`);
		}
		const summaryData = await summaryResponse.json();
		
		if (summaryData.ok) {
			const typeContainer = document.getElementById('typeDistribution');
			const total = summaryData.total || 0;
			
			if (total === 0) {
				typeContainer.innerHTML = '<div class="loading">No feedback yet. Seed the database to get started!</div>';
				return;
			}

			const typeIcons = {
				bug: '🐛',
				idea: '💡',
				general: '📝',
				testimonial: '⭐'
			};

			const typeLabels = {
				bug: 'Bug',
				idea: 'Idea',
				general: 'General',
				testimonial: 'Testimonial'
			};

			const typeBreakdown = summaryData.type || [];
			
			if (typeBreakdown.length === 0) {
				typeContainer.innerHTML = '<div class="loading">No type data available.</div>';
				return;
			}

			// Calculate percentages
			const typeData = typeBreakdown.map(({ type, count, urgent_count, negative_count }) => {
				const urgentPercent = count > 0 ? Math.round((urgent_count / count) * 100) : 0;
				const negativePercent = count > 0 ? Math.round((negative_count / count) * 100) : 0;
				const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
				
				return {
					type,
					count,
					urgentPercent,
					negativePercent,
					percentage
				};
			}).sort((a, b) => b.count - a.count);

			typeContainer.innerHTML = typeData.map(({ type, count, urgentPercent, negativePercent, percentage }) => {
				return `
					<div class="type-item">
						<div class="type-info">
							<div class="type-icon ${type}">${typeIcons[type] || '📄'}</div>
							<div class="type-details">
								<div class="type-name">${typeLabels[type] || type}</div>
								<div class="type-count">${count} feedback</div>
							</div>
						</div>
						<div class="type-bar">
							<div class="type-bar-fill ${type}" style="width: ${percentage}%"></div>
						</div>
						<div class="type-percentages">
							<span class="type-percentage">${percentage}%</span>
							<span class="type-urgent">${urgentPercent}% urgent</span>
							<span class="type-negative">${negativePercent}% negative</span>
						</div>
					</div>
				`;
			}).join('');
		}
	} catch (error) {
		console.error('Error loading type distribution:', error);
	}
}

// Load feedback list
let currentThemeFilter = null;

async function loadFeedback(themeFilter = null) {
	currentThemeFilter = themeFilter;
	try {
		const url = themeFilter 
			? `${API_BASE}/api/feedback?theme=${encodeURIComponent(themeFilter)}`
			: `${API_BASE}/api/feedback`;
		console.log('Fetching feedback from:', url);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const data = await response.json();
		console.log('Feedback data received:', data);
		
		if (data.ok) {
			const tbody = document.getElementById('feedbackTableBody');
			
			if (data.items.length === 0) {
				tbody.innerHTML = '<tr><td colspan="7" class="loading">No feedback yet. Seed the database to get started!</td></tr>';
				return;
			}
			
			// Sort by urgency (highest first), then by ID (newest first)
			const sortedItems = [...data.items].sort((a, b) => {
				const urgencyA = a.urgency || 0;
				const urgencyB = b.urgency || 0;
				if (urgencyB !== urgencyA) {
					return urgencyB - urgencyA; // Higher urgency first
				}
				return b.id - a.id; // Newer first if same urgency
			});
			
			tbody.innerHTML = sortedItems.map((item, index) => {
				const urgencyLevel = item.urgency >= 4 ? 'high' : item.urgency >= 2 ? 'medium' : 'low';
				
				return `
					<tr class="clickable-row" onclick="showFeedbackModal(${item.id})">
						<td>
							<div style="display: flex; align-items: center; gap: 8px;">
								<span class="urgency-rank">#${index + 1}</span>
								<span>#${item.id}</span>
							</div>
						</td>
						<td>
							<div class="content-preview" title="${escapeHtml(item.content)}">
								${escapeHtml(item.content.substring(0, 50))}${item.content.length > 50 ? '...' : ''}
							</div>
						</td>
						<td>${item.type || '-'}</td>
						<td>${item.theme || '-'}</td>
						<td>${item.sentiment || '-'}</td>
						<td>
							${item.urgency ? `
								<span class="priority-badge ${urgencyLevel}">
									<span class="status-dot"></span>
									${item.urgency}/5
								</span>
							` : '-'}
						</td>
						<td>${formatDateTime(item.created_at)}</td>
					</tr>
				`;
			}).join('');
		}
	} catch (error) {
		console.error('Error loading feedback:', error);
		document.getElementById('feedbackTableBody').innerHTML = 
			'<tr><td colspan="7" class="error">Error loading feedback. Please try again.</td></tr>';
	}
}

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// Show feedback modal
async function showFeedbackModal(id) {
	const modal = document.getElementById('feedbackModal');
	const modalContent = document.getElementById('modalContent');
	const modalMeta = document.getElementById('modalMeta');
	const modalSuggestions = document.getElementById('modalSuggestions');

	modal.classList.add('active');
	modalContent.textContent = 'Loading...';
	modalMeta.innerHTML = '';
	modalSuggestions.innerHTML = '<div class="suggestions-loading">Loading suggestions...</div>';

	try {
		// Load feedback details
		const response = await fetch(`${API_BASE}/api/feedback`);
		const data = await response.json();
		
		if (data.ok) {
			const item = data.items.find(i => i.id === id);
			if (!item) {
				modalContent.textContent = 'Feedback not found';
				return;
			}

			// Show content
			modalContent.textContent = item.content;

			// Show metadata
			const urgencyLevel = item.urgency >= 4 ? 'high' : item.urgency >= 2 ? 'medium' : 'low';
			modalMeta.innerHTML = `
				<div class="meta-item">
					<div class="meta-label">Type</div>
					<div class="meta-value">${item.type || 'N/A'}</div>
				</div>
				<div class="meta-item">
					<div class="meta-label">Theme</div>
					<div class="meta-value">${item.theme || 'N/A'}</div>
				</div>
				<div class="meta-item">
					<div class="meta-label">Sentiment</div>
					<div class="meta-value">${item.sentiment || 'N/A'}</div>
				</div>
				<div class="meta-item">
					<div class="meta-label">Urgency</div>
					<div class="meta-value">
						${item.urgency ? `
							<span class="priority-badge ${urgencyLevel}">
								<span class="status-dot"></span>
								${item.urgency}/5
							</span>
						` : 'N/A'}
					</div>
				</div>
				<div class="meta-item">
					<div class="meta-label">Source</div>
					<div class="meta-value">${item.source || 'N/A'}</div>
				</div>
				<div class="meta-item">
					<div class="meta-label">Created At</div>
					<div class="meta-value">${formatDateTime(item.created_at)}</div>
				</div>
			`;

			// Load AI suggestions
			try {
				const suggestionsResponse = await fetch(`${API_BASE}/api/feedback/${id}/suggestions`);
				const suggestionsData = await suggestionsResponse.json();
				
				if (suggestionsData.ok && suggestionsData.suggestions && suggestionsData.suggestions.length > 0) {
					const categoryIcons = {
						immediate: '⚡',
						bug: '🐛',
						product: '💡',
						documentation: '📚',
						communication: '💬',
						'follow-up': '🔄',
					};

					modalSuggestions.innerHTML = `
						<div class="suggestions-list">
							${suggestionsData.suggestions.map(suggestion => {
								const category = suggestion.category || 'follow-up';
								const priority = suggestion.priority || 'medium';
								const theme = suggestion.theme || 'general';
								const action = suggestion.action || 'Action needed';
								const description = suggestion.description || '';
								const reasoning = suggestion.reasoning || 'Based on feedback analysis';
								const confidence = suggestion.confidence || 0.75;
								const confidenceLevel = confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';
								
								return `
									<div class="suggestion-item ${category}">
										<div class="suggestion-header">
											<div class="suggestion-action">
												<span class="suggestion-icon ${category}">${categoryIcons[category] || '📋'}</span>
												<span>${escapeHtml(action)}</span>
											</div>
											<div class="suggestion-meta">
												<span class="suggestion-badge priority-${priority}">${priority}</span>
												<span class="suggestion-badge theme">${theme}</span>
											</div>
										</div>
										<div class="suggestion-description">${escapeHtml(description)}</div>
										<div class="ai-metadata">
											<div class="ai-confidence">
												<span>AI Confidence:</span>
												<span class="confidence-badge ${confidenceLevel}">${(confidence * 100).toFixed(0)}%</span>
											</div>
											<div class="ai-reasoning">${escapeHtml(reasoning)}</div>
										</div>
									</div>
								`;
							}).join('')}
						</div>
					`;
				} else {
					modalSuggestions.innerHTML = '<div class="suggestions-loading">No suggestions available.</div>';
				}
			} catch (error) {
				console.error('Error loading suggestions:', error);
				modalSuggestions.innerHTML = '<div class="suggestions-loading">Error loading suggestions.</div>';
			}
		}
	} catch (error) {
		console.error('Error loading feedback details:', error);
		modalContent.textContent = 'Error loading feedback details.';
	}
}

function closeModal(event) {
	if (event && event.target !== event.currentTarget) return;
	document.getElementById('feedbackModal').classList.remove('active');
}

// Show integration modal with feedback from that source
async function showIntegrationModal(source) {
	const modal = document.getElementById('integrationModal');
	const modalContent = document.getElementById('integrationModalContent');
	const modalTitle = document.getElementById('integrationModalTitle');
	
	modal.classList.add('active');
	modalContent.innerHTML = '<div class="loading">Loading feedback...</div>';
	
	try {
		const response = await fetch(`${API_BASE}/api/integrations/${source}/feedback`);
		const data = await response.json();
		
		if (data.ok) {
			const integrationNames = {
				email: 'Email',
				github: 'GitHub Issues',
				discord: 'Discord',
				cloudflare: 'Cloudflare',
				linkedin: 'LinkedIn'
			};
			
			modalTitle.textContent = `${integrationNames[source] || source} Feedback (${data.count})`;
			
			if (data.items && data.items.length > 0) {
				modalContent.innerHTML = `
					<div class="integration-feedback-list">
						${data.items.map(item => {
							const urgencyLevel = item.urgency >= 4 ? 'high' : item.urgency >= 2 ? 'medium' : 'low';
							return `
								<div class="integration-feedback-item" onclick="showFeedbackModal(${item.id}); closeIntegrationModal();">
									<div class="integration-feedback-header">
										<span class="integration-feedback-id">#${item.id}</span>
										${item.urgency ? `
											<span class="priority-badge ${urgencyLevel}">
												<span class="status-dot"></span>
												${item.urgency}/5
											</span>
										` : ''}
									</div>
									<div class="integration-feedback-content">${escapeHtml(item.content)}</div>
									<div class="integration-feedback-meta">
										<span>${item.type || 'general'}</span>
										${item.theme ? `<span>${item.theme}</span>` : ''}
										${item.sentiment ? `<span>${item.sentiment}</span>` : ''}
										<span>${formatDateTime(item.created_at)}</span>
									</div>
								</div>
							`;
						}).join('')}
					</div>
				`;
			} else {
				modalContent.innerHTML = '<div class="loading">No feedback from this source yet.</div>';
			}
		} else {
			modalContent.innerHTML = '<div class="error">Error loading feedback.</div>';
		}
	} catch (error) {
		console.error('Error loading integration feedback:', error);
		modalContent.innerHTML = '<div class="error">Error loading feedback. Please try again.</div>';
	}
}

function closeIntegrationModal(event) {
	if (event && event.target !== event.currentTarget) return;
	document.getElementById('integrationModal').classList.remove('active');
}

// Filter feedback by theme
function filterByTheme(theme) {
	loadFeedback(theme);
	// Update active state
	document.querySelectorAll('.theme-row').forEach(row => {
		row.classList.remove('active');
	});
	const clickedRow = event?.target?.closest('.theme-row');
	if (clickedRow) {
		clickedRow.classList.add('active');
	}
	// Update filter label
	const filterLabel = document.getElementById('themeFilterLabel');
	const clearButton = document.getElementById('clearFilterButton');
	if (filterLabel && clearButton) {
		filterLabel.textContent = `Filtered by: ${theme}`;
		filterLabel.style.display = 'inline';
		clearButton.style.display = 'inline-block';
	}
}

// Clear theme filter
function clearThemeFilter() {
	currentThemeFilter = null;
	loadFeedback();
	document.querySelectorAll('.theme-row').forEach(row => {
		row.classList.remove('active');
	});
	// Hide filter label
	const filterLabel = document.getElementById('themeFilterLabel');
	const clearButton = document.getElementById('clearFilterButton');
	if (filterLabel && clearButton) {
		filterLabel.style.display = 'none';
		clearButton.style.display = 'none';
	}
}

// Seed database
async function seedDatabase() {
	const button = document.getElementById('seedButton');
	try {
		button.disabled = true;
		button.textContent = 'Seeding...';

		const response = await fetch(`${API_BASE}/api/seed`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
		});

		const data = await response.json();
		
		if (data.ok) {
			showSeedMessage(`Successfully seeded ${data.ids.length} feedback items!`, 'success');
			await loadFeedback();
			await loadSummary();
			await loadTypeDistribution();
			await loadIntegrations();
		} else {
			showSeedMessage(data.error || 'Seeding failed', 'error');
		}

		button.disabled = false;
		button.textContent = 'Seed Database with Sample Feedback';
	} catch (error) {
		console.error('Error seeding database:', error);
		showSeedMessage('Error seeding database. Please try again.', 'error');
		button.disabled = false;
		button.textContent = 'Seed Database with Sample Feedback';
	}
}

// Analyze all unanalyzed feedback
async function analyzeAll() {
	const button = document.getElementById('analyzeAllButton');
	try {
		button.disabled = true;
		button.textContent = 'Analyzing...';

		const response = await fetch(`${API_BASE}/api/analyze-all`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
		});

		const data = await response.json();
		
		if (data.ok) {
			showSeedMessage(`Analyzed ${data.analyzed} out of ${data.total} unanalyzed feedback items.`, 'success');
			await loadFeedback();
			await loadSummary();
			await loadTypeDistribution();
			await loadIntegrations();
		} else {
			showSeedMessage(data.error || 'Analysis failed', 'error');
		}

		button.disabled = false;
		button.textContent = 'Analyze All Unanalyzed Feedback';
	} catch (error) {
		console.error('Error analyzing feedback:', error);
		showSeedMessage('Error analyzing feedback. Please try again.', 'error');
		button.disabled = false;
		button.textContent = 'Analyze All Unanalyzed Feedback';
	}
}

// Load integrations
async function loadIntegrations() {
	try {
		console.log('Fetching integrations from:', `${API_BASE}/api/integrations`);
		const response = await fetch(`${API_BASE}/api/integrations`);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const data = await response.json();
		console.log('Integrations data received:', data);
		
		if (data.ok) {
			const integrationsGrid = document.getElementById('integrationsGrid');
			
			if (data.integrations && data.integrations.length > 0) {
				integrationsGrid.innerHTML = data.integrations.map(integration => `
					<div class="integration-item clickable-integration" onclick="showIntegrationModal('${integration.type}')">
						<div class="integration-header">
							${integration.logo ? `
								<img src="${integration.logo}" alt="${escapeHtml(integration.name)}" class="integration-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
								<div class="integration-icon" style="display: none;">${integration.icon}</div>
							` : `
								<div class="integration-icon">${integration.icon}</div>
							`}
							<div class="integration-info">
								<div class="integration-name">${escapeHtml(integration.name)}</div>
								<div class="integration-status">${integration.status}</div>
							</div>
						</div>
						<div>
							<div class="integration-count">${integration.count}</div>
							<div class="integration-label">feedback items</div>
						</div>
					</div>
				`).join('');
			} else {
				integrationsGrid.innerHTML = '<div class="loading">No integrations configured.</div>';
			}
		}
	} catch (error) {
		console.error('Error loading integrations:', error);
	}
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initialize);
} else {
	// DOM is already ready
	initialize();
}

function initialize() {
	console.log('Initializing dashboard...');
	
	// Set current date range
	const now = new Date();
	const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const dateRangeEl = document.getElementById('dateRange');
	if (dateRangeEl) {
		dateRangeEl.textContent = `${formatDate(weekAgo)} - ${formatDate(now)}`;
	} else {
		console.warn('dateRange element not found');
	}

	// Initial load
	console.log('Loading data...');
	loadSummary().catch(err => console.error('Error loading summary:', err));
	loadFeedback().catch(err => console.error('Error loading feedback:', err));
	loadTypeDistribution().catch(err => console.error('Error loading type distribution:', err));
	loadIntegrations().catch(err => console.error('Error loading integrations:', err));

	// Auto-refresh every 30 seconds
	setInterval(() => {
		loadSummary().catch(err => console.error('Error refreshing summary:', err));
		loadFeedback().catch(err => console.error('Error refreshing feedback:', err));
		loadTypeDistribution().catch(err => console.error('Error refreshing type distribution:', err));
		loadIntegrations().catch(err => console.error('Error refreshing integrations:', err));
	}, 30000);
}
