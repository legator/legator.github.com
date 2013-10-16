$(function () {
    
        var colors = Highcharts.getOptions().colors,
            categories = ['Web', 'Desktop', 'Framework'],
            name = 'Browser brands',
            data = [{
                    y: 25,
                    color: colors[0],
                    drilldown: {
                        name: 'Web technology',
                        categories: ['php', 'javascript', 'mysql', 'html/css'],
                        data: [10, 7, 5, 3],
                        color: colors[0]
                    }
                }, {
                    y: 55,
                    color: colors[1],
                    drilldown: {
                        name: 'Desktop technology',
                        categories: ['c#', 'Java', 'QT/C++'],
                        data: [35, 12, 8],
                        color: colors[1]
                    }
                }, {
                    y: 25,
                    color: colors[2],
                    drilldown: {
                        name: 'Framework',
                        categories: ['XML/Json', 'MVC'],
                        data: [15, 10],
                        color: colors[2]
                    }
                }];
    
    
        // Build the data arrays
        var browserData = [];
        var versionsData = [];
        for (var i = 0; i < data.length; i++) {
    
            // add browser data
            browserData.push({
                name: categories[i],
                y: data[i].y,
                color: data[i].color
            });
    
            // add version data
            for (var j = 0; j < data[i].drilldown.data.length; j++) {
                var brightness = 0.2 - (j / data[i].drilldown.data.length) / 5 ;
                versionsData.push({
                    name: data[i].drilldown.categories[j],
                    y: data[i].drilldown.data[j],
                    color: Highcharts.Color(data[i].color).brighten(brightness).get()
                });
            }
        }
    
        // Create the chart
        $('#skills').highcharts({
            chart: {
                type: 'pie'
            },
            title: {
                text: 'Skills'
            },
            yAxis: {
                title: {
                    text: 'Total percent market share'
                }
            },
            plotOptions: {
                pie: {
                    shadow: false,
                    center: ['50%', '50%']
                }
            },
            tooltip: {
        	    valueSuffix: '%'
            },
            series: [{
                name: 'Type',
                data: browserData,
                size: '60%',
                dataLabels: {
                    formatter: function() {
                        return this.y > 5 ? this.point.name : null;
                    },
                    color: 'white',
                    distance: -30
                }
            }, {
                name: 'Technology',
                data: versionsData,
                size: '80%',
                innerSize: '60%',
                dataLabels: {
                    formatter: function() {
                        // display only if larger than 1
                        return this.y > 1 ? '<b>'+ this.point.name +':</b> '+ this.y +'%'  : null;
                    }
                }
            }]
        });
    });